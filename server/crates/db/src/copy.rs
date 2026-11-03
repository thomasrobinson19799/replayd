//! Binary `COPY … FROM STDIN` helpers for batched inserts (§5.1, §5.5).

use futures_util::pin_mut;
use tokio_postgres::binary_copy::BinaryCopyInWriter;
use tokio_postgres::types::{ToSql, Type};

use crate::DbError;

/// Copies `rows` into `table(columns)` using the binary COPY protocol. Returns rows written.
pub async fn copy_rows(
    c: &tokio_postgres::Client,
    table: &str,
    columns: &[&str],
    types: &[Type],
    rows: &[Vec<&(dyn ToSql + Sync)>],
) -> Result<u64, DbError> {
    let sql = format!("COPY {table} ({}) FROM STDIN (FORMAT binary)", columns.join(", "));
    let sink = c.copy_in(&sql).await?;
    let writer = BinaryCopyInWriter::new(sink, types);
    pin_mut!(writer);
    for r in rows {
        writer.as_mut().write(r).await?;
    }
    Ok(writer.finish().await?)
}
