/** Shared migration helpers for db.ts (PGLite) and migrate.mjs. */

export function isMigrationFile(name) {
  return /^\d{4}.*\.sql$/i.test(name) && !name.includes("/");
}

/**
 * @param {string[]} paths - keys from import.meta.glob (e.g. "/migrations/0002_catalog.sql")
 * @param {string[]} done - names already applied (filename only)
 */
export function pendingMigrations(paths, done) {
  const doneSet = new Set(done);
  return paths
    .map((path) => {
      const name = path.split("/").pop() ?? path;
      return { name, path };
    })
    .filter(({ name }) => isMigrationFile(name) && !doneSet.has(name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
