// Where a simple SQL scanner and DuckDB read the same text differently. sql.test.mjs holds the guard
// to DuckDB's reading, and engine-host.test.mjs holds these lists to DuckDB itself, so a change in
// how DuckDB reads SQL fails a test rather than opening a way past the guard.
const COPY = "COPY (SELECT 1) TO 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/x.csv'";

// Each passes for one read to a scanner that disagrees, and DuckDB runs its COPY.
export const WRITES = [
  `/* /* */ SELECT 1 */ ${COPY}`,                   // block comments nest
  `/* /* /* */ */ SELECT 1 */ ${COPY}`,
  `SELECT E'\\'' ; ${COPY} --'`,                    // a backslash escapes in an E-string
  `SELECT e'\\'' ; ${COPY} --'`,
  `SELECT 1 AS a$b$ ; ${COPY}`,                     // a '$' inside a word opens nothing
  `SELECT $é$'$é$ AS a ; ${COPY} --'`,              // a tag can hold more than ASCII
  `SELECT 1 -- c\r; ${COPY}`,                       // a carriage return ends a line comment
];

// Each looks like more than one statement, or a write, to the same scanner, and is one read.
export const READS = [
  "/* /* nested */ COPY */ SELECT 1",
  "SELECT E'it\\'s; COPY' AS a",
  "SELECT 'a\\' AS a",
  "SELECT 1 AS a$b$",
  "SELECT $$a; COPY$$ AS a",
  "SELECT $é$a; COPY$é$ AS a",
  "SELECT 1 AS a -- COPY\r\nFROM range(1)",
];
