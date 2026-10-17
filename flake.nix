{
  description = "scribblr: a Chrome extension that swaps parts of the pages you read into the language you're learning";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          inherit (pkgs) lib stdenv;
          # Chromium (for the end-to-end tests) is only packaged for Linux.
          testBrowser = lib.optionals stdenv.isLinux [ pkgs.chromium ];
          fonts = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts pkgs.liberation_ttf ]; };
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.git ] ++ testBrowser;

            env = {
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            } // lib.optionalAttrs stdenv.isLinux {
              SCRIBBLR_CHROMIUM = "${pkgs.chromium}/bin/chromium";
              FONTCONFIG_FILE = "${fonts}";
            };

            shellHook = ''
              # Install npm dependencies on first use, and again whenever package-lock.json changes.
              if [ -f package-lock.json ] && { [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; }; then
                echo "scribblr: installing npm dependencies…" >&2
                npm ci --no-audit --no-fund >&2
              fi
            '';
          };
        });
    };
}
