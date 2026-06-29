export interface SqliteStatement {
    bind(params: unknown[]): void;
    run(params?: unknown[]): void;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    free(): void;
}

export interface SqliteDatabase {
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): SqliteStatement;
    close(): void;
    export(): Uint8Array;
    getRowsModified(): number;
}

export interface SqliteModule {
    Database: new (data?: Uint8Array) => SqliteDatabase;
}
