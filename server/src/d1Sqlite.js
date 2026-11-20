import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sanitizeParams(params) {
  return params.map((p) => (p === undefined ? null : p));
}

class SqliteD1Statement {
  constructor(db, sql, boundParams = []) {
    this.db = db;
    this.sql = sql;
    this.boundParams = boundParams;
  }

  bind(...params) {
    return new SqliteD1Statement(this.db, this.sql, sanitizeParams(params));
  }

  _executeSync() {
    const stmt = this.db.prepare(this.sql);
    const trimmed = this.sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
      const results = stmt.all(...this.boundParams);
      return { results, success: true, meta: {} };
    }
    const info = stmt.run(...this.boundParams);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info?.changes ?? 0),
        last_row_id: info?.lastInsertRowid != null ? Number(info.lastInsertRowid) : 0,
      },
    };
  }

  async first(colName = null) {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.boundParams);
    if (!row) return null;
    if (colName) return Object.prototype.hasOwnProperty.call(row, colName) ? row[colName] : null;
    return { ...row };
  }

  async all() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.boundParams);
    return {
      results: rows.map((r) => ({ ...r })),
      success: true,
      meta: {},
    };
  }

  async run() {
    return this._executeSync();
  }
}

export function createSqliteD1Database(filename = ':memory:') {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const rawDb = new DatabaseSync(filename);
  if (filename !== ':memory:') {
    rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  }

  return {
    prepare(sql) {
      return new SqliteD1Statement(rawDb, sql, []);
    },
    async batch(statements) {
      const results = [];
      rawDb.exec('BEGIN');
      try {
        for (const stmt of statements) {
          results.push(stmt._executeSync());
        }
        rawDb.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          rawDb.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    },
    async exec(sql) {
      rawDb.exec(sql);
      return { count: 1, duration: 0 };
    },
    close() {
      rawDb.close();
    },
  };
}
