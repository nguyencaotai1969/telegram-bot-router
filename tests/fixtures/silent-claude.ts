// Stand-in for a claude.exe that never answers anything (its arguments are ignored), then goes away after 3 s.
export {}

await Bun.sleep(3000)
