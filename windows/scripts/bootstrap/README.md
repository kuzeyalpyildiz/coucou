# Latest installer

`coucou-latest.exe` queries `kuzeyalpyildiz/coucou-custom`'s latest stable public
GitHub Release each time it runs. It does not use expiring Actions artifacts,
prereleases, or a bundled fallback MSI. Internet access and .NET Framework 4.x
are required. This distribution currently installs the x64 Windows package.

Publish exactly one versioned `*_x64_en-US.msi` and `SHA256SUMS.txt` alongside
the bootstrapper in each stable release. The manifest must contain the MSI's
SHA-256 and exact filename. Missing/ambiguous assets, unavailable networking,
or mismatched checksums stop installation. Checksums detect corruption, not
a compromised publisher; binaries are not code-signed by this build script.

Build using `windows/scripts/build-bootstrap.ps1`. The Windows candidate
workflow and `npm run pack` include the resulting EXE alongside ordinary
offline installers. Merely producing a candidate does not publish a release.
No suitable public release means the bootstrapper displays an error.

Before shipping, test on Windows: no release, offline/API failure, missing
checksum, corrupted MSI, cancelled elevation, successful install and upgrade,
and an old bootstrapper fetching a newly published release. A native compile
alone does not verify these network/installer scenarios.
