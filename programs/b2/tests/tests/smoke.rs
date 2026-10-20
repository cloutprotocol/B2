//! The world loads the Bordrless programs from bordr_pair/fixtures/ (the fresh mainnet dumps),
//! never from bordrless/sbf/ (the stale ones another suite pins): SBF_OUT_DIR is this crate's
//! .cargo/config.toml's, and every loaded program's bytes are the dump's.
use bordrless_program_tests::fixture::World;

#[test]
fn the_world_loads_the_fresh_dumps() {
    let dir = bordrless_program_tests::sbf_out_dir();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures").canonicalize().unwrap();
    assert_eq!(dir.canonicalize().unwrap(), fixtures, "SBF_OUT_DIR");
    let w = World::new();
    for (name, id) in [
        ("bordrless_token", bordrless_token::ID),
        ("bordrless_swap", bordrless_swap::ID),
        ("bordrless_launch", bordrless_launch::ID),
        ("bordrless_bridge", bordrless_bridge::ID),
        ("bordrless_companion", bordrless_companion::ID),
    ] {
        let file = std::fs::read(fixtures.join(format!("{name}.so"))).unwrap();
        let pd = anchor_lang::prelude::Pubkey::find_program_address(
            &[id.as_ref()],
            &bordrless_program_tests::env::LOADER_V3,
        )
        .0;
        let loaded = w.env.account(&pd).expect("programdata").data;
        assert_eq!(&loaded[45..45 + file.len()], &file[..], "{name} is the fixture's");
        println!("{name}: {} bytes from {}", file.len(), fixtures.display());
    }
}
