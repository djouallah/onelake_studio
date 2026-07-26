# Generates the .duckdb fixture that test/sql-integration.html attaches over HTTP.
# Regenerate rather than commit the binary — half a megabyte of database file has no
# business in git, and the storage format must roughly match the pinned DuckDB-WASM
# anyway (a 1.x file reads in 1.5.4; regenerate if the pin ever jumps a storage version).
#
#   pip install duckdb
#   python test/fixtures/make_sample.py
#   cp test/fixtures/sample.duckdb site/__sample.duckdb   # then run the harness
import os
import duckdb

path = os.path.join(os.path.dirname(__file__), "sample.duckdb")
if os.path.exists(path):
    os.remove(path)
con = duckdb.connect(path)
con.execute("CREATE TABLE t1 AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) v(id, s)")
con.execute("CREATE VIEW v1 AS SELECT id * 10 AS id10 FROM t1")
con.close()
print("wrote", path, os.path.getsize(path), "bytes")
