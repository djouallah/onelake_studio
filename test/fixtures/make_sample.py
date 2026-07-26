# Generates the database fixtures that test/sql-integration.html attaches over HTTP:
# a DuckDB file and a SQLite file (deliberately named .db — the extension the app must
# sniff rather than trust). Regenerate rather than commit binaries — and the DuckDB
# storage format must roughly match the pinned DuckDB-WASM anyway (a 1.x file reads in
# 1.5.4; regenerate if the pin ever jumps a storage version).
#
#   pip install duckdb            # sqlite3 is stdlib
#   python test/fixtures/make_sample.py
#   cp test/fixtures/sample.duckdb site/__sample.duckdb
#   cp test/fixtures/sample_sqlite.db site/__sample_sqlite.db
import os
import sqlite3
import duckdb

here = os.path.dirname(__file__)

path = os.path.join(here, "sample.duckdb")
if os.path.exists(path):
    os.remove(path)
con = duckdb.connect(path)
con.execute("CREATE TABLE t1 AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) v(id, s)")
con.execute("CREATE VIEW v1 AS SELECT id * 10 AS id10 FROM t1")
con.close()
print("wrote", path, os.path.getsize(path), "bytes")

spath = os.path.join(here, "sample_sqlite.db")
if os.path.exists(spath):
    os.remove(spath)
sq = sqlite3.connect(spath)
sq.execute("CREATE TABLE s1 (id INTEGER, s TEXT)")
sq.executemany("INSERT INTO s1 VALUES (?, ?)", [(1, "a"), (2, "b"), (3, "c")])
sq.commit()
sq.close()
print("wrote", spath, os.path.getsize(spath), "bytes")
