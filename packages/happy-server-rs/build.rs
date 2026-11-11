// Embeds the TS server's Prisma migrations so `happy-server-rs migrate` can set up a
// fresh database exactly like `prisma migrate deploy` (same checksums).
use std::fs;
use std::path::Path;

fn main() {
    let dir = Path::new("../happy-server/prisma/migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("migration.sql").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut out = String::from("pub static PRISMA_MIGRATIONS: &[(&str, &str)] = &[\n");
    for n in names {
        let p = fs::canonicalize(dir.join(&n).join("migration.sql")).unwrap();
        out.push_str(&format!("    ({:?}, include_str!({:?})),\n", n, p.display().to_string()));
    }
    out.push_str("];\n");
    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("prisma_migrations.rs");
    fs::write(dest, out).unwrap();
}
