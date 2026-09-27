import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Filesystem seam for the relay's two small persisted documents: live rooms
 * (`ROOMS_PATH`, `./rooms/persistence.ts`) and the relay's identity key
 * (`IDENTITY_PATH`, `./relayIdentity.ts`). Production binds these to `node:fs`;
 * tests inject an in-memory implementation so behavior stays deterministic and
 * the suite never touches disk.
 *
 * Deliberately synchronous. Both documents are small, and an asynchronous write
 * would force the message router to become asynchronous for a rare message,
 * while the shutdown flush would race the process exit that follows it.
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
};
