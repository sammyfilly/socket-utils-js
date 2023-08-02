/// <reference types="node" />
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Writable, addAbortSignal, Readable, PassThrough } from 'node:stream'

import { subscribe as subscribeWatcher } from '@parcel/watcher'
import { VFS, VFSError, VFSFileHandle, path as vfsPath } from '@socketsecurity/vfs'
import { matcher } from 'micromatch'

import type {
  AsyncSubscription as WatcherSubscription,
  Event as WatchEvent
} from '@parcel/watcher'
import type {
  VFSWriteStream, VFSDirent, VFSEntryType, VFSErrorCode,
  VFSReadStream, VFSWatchCallback, VFSWatchErrorCallback
} from '@socketsecurity/vfs'
import type { FileHandle } from 'node:fs/promises'
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream
} from 'node:stream/web'

// unfortunate but necessary
declare global {
  interface ReadableStream<R = any> extends NodeReadableStream<R> {}
  interface WritableStream<W = any> extends NodeWritableStream<W> {}
}

const allowedErrorTypes = new Set([
  'ENOENT',
  'ENOSYS',
  'EISDIR',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'EBADF',
  'EINVAL',
  'EEXIST',
  'EUNKNOWN'
])

const wrapVFSErr = (err: unknown) => {
  if (!(err instanceof Error)) {
    return new VFSError(`${err}`)
  }
  if (err.name === 'AbortError') return err
  if (err.name === 'VFSError') return err
  let code: VFSErrorCode = 'EUNKNOWN'
  let message = err.message
  if ('code' in err && allowedErrorTypes.has(err.code as string)) {
    code = err.code as VFSErrorCode
    if (message.startsWith(`${code}: `)) {
      message = message.slice(code.length + 2)
    }
  }
  return new VFSError(message, { code, cause: err })
}

const withVFSErr = <T>(promise: Promise<T>) => promise.catch(err => {
  throw wrapVFSErr(err)
})

const ensureDir = async (path: string) => {
  const statInfo = await withVFSErr(fs.promises.stat(path))
  if (!statInfo.isDirectory()) {
    throw new VFSError(`${path} is not a directory`, { code: 'ENOTDIR' })
  }
  return path
}

const getEntryType = (entry: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): VFSEntryType | null => {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  if (entry.isSymbolicLink()) return 'symlink'
  return null
}

const wrapNodeReadable = (gen: () => Promise<Readable>, signal?: AbortSignal): Readable => {
  const out = new PassThrough()
  if (signal) addAbortSignal(signal, out)
  gen().then(s => s.pipe(out)).catch(err => out.destroy(err))
  return out
}

const wrapNodeWritable = (gen: () => Promise<Writable>, signal?: AbortSignal): Writable => {
  const out = new PassThrough()
  if (signal) addAbortSignal(signal, out)
  gen().then(s => s.pipe(out)).catch(err => out.destroy(err))
  return out
}

// needed for error wrapping vs Readable.toWeb
const nodeToVFSReadable = (stream: Readable): VFSReadStream<Buffer> => {
  const webStream = Readable.toWeb(stream)
  stream.prependOnceListener('error', err => {
    void webStream.cancel(wrapVFSErr(err))
  })
  // cast basically assumes all Node Readable streams will have Node.js' extensions
  return webStream as VFSReadStream<Buffer>
}

const nodeToVFSWritable = (stream: Writable): VFSWriteStream => {
  const webStream = Writable.toWeb(stream)
  stream.prependOnceListener('error', err => {
    void webStream.abort(wrapVFSErr(err))
  })
  // not needed but might be if lib.dom.d.ts is loaded
  return webStream as VFSWriteStream
}

class NodeVFSFileHandle extends VFSFileHandle {
  private _handle: FileHandle

  private constructor (handle: FileHandle) {
    super()
    this._handle = handle
  }

  protected async _stat () {
    const stats = await withVFSErr(this._handle.stat())

    const entryType = getEntryType(stats)

    if (!entryType) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      type: entryType,
      size: stats.size
    }
  }

  protected async _truncate (to: number) {
    await withVFSErr(this._handle.truncate(to))
  }

  protected async _flush () {
    await withVFSErr(this._handle.datasync())
  }

  protected async _read (into: Uint8Array, position: number): Promise<number> {
    const { bytesRead } = await withVFSErr(this._handle.read(into, 0, into.byteLength, position))
    return bytesRead
  }

  protected async _write (data: Uint8Array, position: number) {
    const { bytesWritten } = await withVFSErr(
      this._handle.write(data, 0, data.byteLength, position)
    )
    return bytesWritten
  }

  protected async _close () {
    await withVFSErr(this._handle.close())
  }

  static async open (filepath: string, flag: number) {
    const handle = await withVFSErr(fs.promises.open(filepath, flag))
    return new NodeVFSFileHandle(handle)
  }

  protected [Symbol.for('nodejs.util.inspect.custom')] () {
    return `NodeVFSFileHandle(fd = ${this._handle.fd})`
  }
}

type WatchCallback = {
  isMatch: (path: string) => boolean
  fire: VFSWatchCallback
  err: VFSWatchErrorCallback
}

export class NodeVFS extends VFS<
  Buffer
> {
  private _base: string
  private _root: string
  private _watchCallbacks: Set<WatchCallback>
  private _watcher?: WatcherSubscription

  constructor (basePath?: string) {
    super()
    this._base = fs.realpathSync.native(basePath ?? '.')
    this._root = path.parse(this._base).root
    this._watchCallbacks = new Set()
  }

  private _locOK (p: string) {
    return p.startsWith(this._base) && (
      p.length === this._base.length ||
      p[this._base.length] === path.sep
    )
  }

  private async _validatePath (src: string[], thruLast: boolean) {
    let p = this._base
    let strict = true
    let depth = 0
    for (let i = 0; i < src.length; ++i) {
      if (src[i] === '..') {
        p = path.join(p, '..')
        if (strict && !this._locOK(p)) {
          return null
        }
        continue
      }

      const child = src[i] && src[i] !== '.' ? p + path.sep + src[i] : p
      try {
        const linkPath = await fs.promises.readlink(child)
        if (++depth > 40) {
          throw new VFSError('too many symlinks', { code: 'EINVAL' })
        }
        if (!thruLast && i === src.length - 1) {
          p = child
          break
        }
        if (path.isAbsolute(linkPath)) {
          const parsed = path.parse(linkPath)
          const newSrc = parsed.dir.split(path.sep)
          newSrc.push(parsed.base)
          for (++i; i < src.length; ++i) newSrc.push(src[i])
          strict = false
          p = parsed.root
          src = newSrc
          i = 0
        } else {
          const newSrc = linkPath.split(path.sep)
          for (++i; i < src.length; ++i) newSrc.push(src[i])
          strict = true
          src = newSrc
          i = 0
        }
      } catch (err) {
        p = child
        if (err instanceof VFSError) throw err
        if ((err as { code?: unknown } | undefined)?.code === 'EINVAL') {
          continue
        }
        if ((err as { code?: unknown } | undefined)?.code === 'ENOENT') {
          if (i === src.length - 1) {
            // OK if last part doesn't exist
            continue
          }
        }
        throw wrapVFSErr(err)
      }
    }

    return this._locOK(p) ? p : null
  }

  private async _fsPath (src: string[], throughLast = true) {
    if (!src.length) return this._base
    const loc = await this._validatePath(src, throughLast)
    if (!loc) {
      throw new VFSError('path outside base directory', { code: 'EINVAL' })
    }
    return loc
  }

  private _relPath (src: string, absolute: boolean) {
    if (path.parse(src).root !== this._root) {
      throw new VFSError('cannot resolve filepath outside filesystem root', { code: 'ENOSYS' })
    }
    return vfsPath.join(absolute ? '/' : '.', ...path.relative(this._base, src).split(path.sep))
  }

  private _onWatchEvent (err: Error | null, events: WatchEvent[]) {
    if (err) {
      const wrapped = new VFSError(err.message, { cause: err })
      for (const cb of this._watchCallbacks) {
        cb.err(wrapped)
      }
    }
    for (const event of events) {
      // TODO: get rid of this if micromatch cwd ever actually works
      const absPath = this._relPath(event.path, true)
      const relPath = this._relPath(event.path, false)
      const absEvt = {
        path: absPath,
        type: event.type
      }
      const relEvt = {
        path: relPath,
        type: event.type
      }
      for (const cb of this._watchCallbacks) {
        if (cb.isMatch(absPath)) {
          cb.fire(absEvt)
        } else if (cb.isMatch(relPath)) {
          cb.fire(relEvt)
        }
      }
    }
  }

  protected async _appendFile (file: string[], data: Uint8Array, signal?: AbortSignal) {
    await withVFSErr(fs.promises.writeFile(await this._fsPath(file), data, { flag: 'a', signal }))
  }

  protected _appendFileStream (file: string[], signal?: AbortSignal | undefined) {
    return nodeToVFSWritable(wrapNodeWritable(async () => {
      return fs.createWriteStream(await this._fsPath(file), { flags: 'a' })
    }, signal))
  }

  protected async _copyDir (src: string[], dst: string[], _signal?: AbortSignal | undefined) {
    // unfortunately we have a race condition here, not much we can do
    const [srcPath, dstPath] = await Promise.all([
      this._fsPath(src).then(ensureDir),
      this._fsPath(dst).then(async p => {
        await ensureDir(path.dirname(p))
        return p
      })
    ])
    // TODO: handle abort signal
    // trailing slashes needed to handle case of symlinks
    await withVFSErr(fs.promises.cp(srcPath + '/', dstPath + '/', { recursive: true }))
  }

  protected async _copyFile (src: string[], dst: string[], _signal?: AbortSignal | undefined) {
    // TODO: handle abort signal
    const [srcPath, dstPath] = await Promise.all([this._fsPath(src), this._fsPath(dst)])
    await withVFSErr(fs.promises.copyFile(srcPath, dstPath))
  }

  protected async _exists (file: string[]) {
    // Node.js doesn't like this because it allows for race conditions
    // We accept that risk here - avoid existsSync to not block
    try {
      // no this.fsPath because this is a public API method
      await withVFSErr(fs.promises.stat(await this._fsPath(file)))
      return true
    } catch (err) {
      if (err instanceof VFSError && err.code === 'ENOENT') {
        return false
      }
      throw err
    }
  }

  protected async _readDir (dir: string[]) {
    return await withVFSErr(fs.promises.readdir(await this._fsPath(dir)))
  }

  protected async _readDirent (dir: string[]) {
    const dirents = await withVFSErr(
      fs.promises.readdir(await this._fsPath(dir),
      { withFileTypes: true })
    )
    return dirents.map<VFSDirent | null>(ent => {
      const type = getEntryType(ent)
      return type && {
        type,
        name: ent.name
      }
    }).filter((ent): ent is VFSDirent => ent !== null)
  }

  protected async _readFile (file: string[], signal?: AbortSignal | undefined) {
    return await withVFSErr(fs.promises.readFile(await this._fsPath(file), { signal }))
  }

  protected _readFileStream (file: string[], signal?: AbortSignal | undefined) {
    return nodeToVFSReadable(wrapNodeReadable(async () => {
      return fs.createReadStream(await this._fsPath(file))
    }, signal))
  }

  protected async _removeDir (
    dir: string[],
    recursive: boolean,
    _signal?: AbortSignal | undefined
  ) {
    // TODO: handle abort signal
    // trailing slash helps symlinks
    await withVFSErr(fs.promises.rm(await ensureDir(await this._fsPath(dir) + '/'), { recursive }))
  }

  protected async _removeFile (
    file: string[],
    _signal?: AbortSignal | undefined
  ) {
    await withVFSErr(fs.promises.unlink(await this._fsPath(file, false)))
  }

  protected async _stat (file: string[]) {
    const stat = await withVFSErr(fs.promises.stat(await this._fsPath(file)))
    const type = getEntryType(stat)

    if (!type) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      size: stat.size,
      type
    }
  }

  protected async _lstat (file: string[]) {
    const stat = await withVFSErr(fs.promises.lstat(await this._fsPath(file, false)))
    const type = getEntryType(stat)

    if (!type) {
      throw new VFSError('unknown file type', { code: 'ENOSYS' })
    }

    return {
      size: stat.size,
      type
    }
  }

  protected async _writeFile (file: string[], data: Uint8Array, signal?: AbortSignal | undefined) {
    await withVFSErr(fs.promises.writeFile(await this._fsPath(file), data, { signal }))
  }

  protected _writeFileStream (file: string[], signal?: AbortSignal | undefined) {
    return nodeToVFSWritable(wrapNodeWritable(async () => {
      return fs.createWriteStream(await this._fsPath(file))
    }, signal))
  }

  protected async _truncate (file: string[], to: number) {
    await withVFSErr(fs.promises.truncate(await this._fsPath(file), to))
  }

  protected async _symlink (target: string[], link: string[], relative: boolean) {
    // verify this target path can't do parent traversal, relative or not
    await withVFSErr(fs.promises.symlink(
      (relative ? '' : this._base + path.sep) + target.join(path.sep),
      await this._fsPath(link)
    ))
  }

  protected async _realPath (link: string[]) {
    const result = await withVFSErr(fs.promises.realpath(await this._fsPath(link)))
    return this._relPath(result, true)
  }

  protected async _readSymlink (link: string[]) {
    const fsLoc = await this._fsPath(link, false)
    const result = await withVFSErr(fs.promises.readlink(fsLoc))
    const targetPath = path.resolve(path.dirname(fsLoc), result)
    return this._relPath(targetPath, true)
  }

  protected async _rename (src: string[], dst: string[]) {
    const [srcPath, dstPath] = await Promise.all([this._fsPath(src), this._fsPath(dst)])
    await withVFSErr(fs.promises.rename(srcPath, dstPath))
  }

  protected async _mkdir (dir: string[]) {
    // trailing slash allows making through symlinks
    await withVFSErr(fs.promises.mkdir(await this._fsPath(dir) + '/'))
  }

  protected async _openFile (file: string[], read: boolean, write: boolean, truncate: boolean) {
    let flag = write
      ? read
        ? fs.constants.O_RDWR | fs.constants.O_CREAT
        : fs.constants.O_WRONLY | fs.constants.O_CREAT
      : fs.constants.O_RDONLY

    if (truncate) {
      flag |= fs.constants.O_TRUNC
    }

    return await NodeVFSFileHandle.open(await this._fsPath(file), flag)
  }

  protected async _watch (glob: string, onEvent: VFSWatchCallback, onError: VFSWatchErrorCallback) {
    const entry = {
      isMatch: matcher(glob, {
        nocase: true,
        dot: true,
        // TODO: this does nothing
        cwd: '/'
      }),
      fire: onEvent,
      err: onError
    }
    this._watchCallbacks.add(entry)
    if (!this._watcher) {
      this._watcher = await withVFSErr(subscribeWatcher(this._base, this._onWatchEvent))
    }
    return async () => {
      this._watchCallbacks.delete(entry)
      if (!this._watchCallbacks.size) {
        const watcher = this._watcher
        this._watcher = undefined
        await withVFSErr(watcher!.unsubscribe())
      }
    }
  }

  protected [Symbol.for('nodejs.util.inspect.custom')] () {
    return `NodeVFS(root = ${this._base})`
  }
}
