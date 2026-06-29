import type { SqliteDatabase } from '../SqliteTypes';

export interface Migration {
    version: number;
    up(db: SqliteDatabase): Promise<void>;
}
