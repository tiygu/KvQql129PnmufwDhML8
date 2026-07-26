# Store catalog knowledge in SQLite and icon content in a hashed file cache

SQLite will be the system of record for catalog observations, inferred candidates, active versions, field-level human rulings, review history, conflicts, and icon metadata. Binary icon content will live in a content-addressed file cache referenced by hash from SQLite, while `item-catalog.json` remains an import, export, diagnostic, and fixture format rather than mutable runtime truth.
