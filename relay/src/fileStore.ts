import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Filesystem seam for the relay's two small persisted documents: live rooms
 * (`ROOMS_PATH`, `./rooms/persistence.ts`) and the relay's identity key
 * (`IDENTITY_PATH`, `./relayIdentity.ts`). Production binds these to `node:fs`;
 * tests inject an in-memory implementation so behavior stays deterministic and
 * the suite never touches disk.
 *
 * Synchronous by default. Both documents are small, and an asynchronous write
 * would force the message router to become asynchronous for a rare message,
 * while the shutdown flush would race the process exit that follows it.
 *
 * **The one exception is the rooms document's trailing save** (`writeAsync`).
 * Measured: a Proxmox snapshot backup of the relay's VM stretched
 * disk waits to ~2.4 s, and the synchronous save held the event loop for 46 to
 * 112 s at a time mid-party — no pong, no healthcheck, every client dropped
 * together. A save nobody waits on must not be able to stop the relay.
 */
export interface FileStorage {
  /**
   * Throws an error whose `code` is `'ENOENT'` when the document does not exist
   * (the normal first-boot case). Any other throw is a read *failure* — a file
   * that is there and cannot be read — and callers that would otherwise mint a
   * replacement must not treat the two alike (`./relayIdentity.ts`).
   */
  read: (path: string) => string;
  /**
   * MUST replace `path` atomically, so a crash mid-write cannot truncate it.
   * `mode` restricts the created file where the filesystem honours modes; the
   * relay's private key (`IDENTITY_PATH`) asks for `0o600`.
   */
  write: (path: string, contents: string, options?: { mode?: number }) => void;
  /**
   * `write` in the background, for a save nobody waits on. Optional: a storage without it is
   * written synchronously. `commit` is asked just before the atomic rename; `false` abandons this
   * write, so a newer synchronous write (the shutdown flush) is never overwritten by an older
   * background one that reaches the disk after it.
   */
  writeAsync?: (
    path: string,
    contents: string,
    options?: { mode?: number; commit?: () => boolean },
  ) => Promise<void>;
}

export const fsFileStorage: FileStorage = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, contents, options) => {
    mkdirSync(dirname(path), { recursive: true });
    // Write beside the target and rename: rename is atomic within a filesystem,
    // so the next boot sees either the whole old file or the whole new one.
    // The mode applies to the temporary file at creation and travels with the
    // rename, so the key is never on disk for an instant with wider permissions.
    //
    // A `.tmp` left behind by a crash between the write and the rename would otherwise be reused
    // as it is — `writeFileSync`'s mode applies only to a file it creates — and carry its wider
    // mode onto the key (security review L2). So it is removed first, the new one is created
    // exclusively (`wx`: a file that reappears in between fails the write rather than being
    // trusted), and the mode is set again explicitly before the rename, whatever the umask did.
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, contents, {
      encoding: 'utf8',
      flag: 'wx',
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options?.mode !== undefined) chmodSync(tmp, options.mode);
    renameSync(tmp, path);
  },
  writeAsync: async (path, contents, options) => {
    // The same steps as `write`, off the event loop, beside a temporary file of its own so a
    // synchronous `write` running meanwhile (the shutdown flush) cannot remove it mid-write.
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.async.tmp`;
    await rm(tmp, { force: true });
    await writeFile(tmp, contents, {
      encoding: 'utf8',
      flag: 'wx',
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options?.mode !== undefined) await chmod(tmp, options.mode);
    if (options?.commit !== undefined && !options.commit()) {
      await rm(tmp, { force: true });
      return;
    }
    await rename(tmp, path);
  },
};
