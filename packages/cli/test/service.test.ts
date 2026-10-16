import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import { envFilesSetToken, explicitArgs, needsTokenEnvFile, runsAsSystemdService, serviceUnit, systemdQuote, userUnitDir, workerArgs } from "../dist/service.js";

describe("worker service unit", () => {
  it("passes on only the options that differ from start-worker's defaults", () => {
    assert.deepEqual(workerArgs({ hub: "192.168.1.10", port: 7420, sandbox: "docker" }, 7420), ["start-worker", "--hub", "192.168.1.10"]);
    assert.deepEqual(
      workerArgs({ hub: "hub.lan", port: 9000, workDir: "/srv/aso", slots: 3, sandbox: "none", sandboxImage: "img:1", sandboxNetwork: "none" }, 7420),
      ["start-worker", "--hub", "hub.lan", "--port", "9000", "--work-dir", "/srv/aso", "--slots", "3", "--sandbox", "none", "--sandbox-image", "img:1", "--sandbox-network", "none"],
    );
    assert.ok(workerArgs({ hub: "h", workDir: "rel/dir" }, 7420).at(-1)!.startsWith("/"), "relative work dirs become absolute");
  });

  it("quotes words for systemd, escaping specifiers and variables", () => {
    assert.equal(systemdQuote("/usr/bin/node"), "/usr/bin/node");
    assert.equal(systemdQuote("frontend,qa"), "frontend,qa");
    assert.equal(systemdQuote("/home/me/My Apps/aso"), '"/home/me/My Apps/aso"');
    assert.equal(systemdQuote("50%"), '"50%%"');
    assert.equal(systemdQuote("$HOME"), '"$$HOME"');
    assert.equal(systemdQuote('say "hi"\\'), '"say \\"hi\\"\\\\"');
  });

  it("runs the installed aso with restarts, the install-time PATH and the token file", () => {
    const unit = serviceUnit({
      description: "ASO worker (Hub 192.168.1.10)",
      installedBy: "aso service",
      node: "/usr/bin/node",
      script: "/usr/lib/node_modules/@aso/cli/dist/aso.mjs",
      args: ["start-worker", "--hub", "192.168.1.10"],
      path: "/home/me/.nvm/bin:/usr/bin",
      envFile: "/home/me/.config/aso/worker.env",
    });
    assert.match(unit, /^# Installed by `aso service install`; remove with `aso service uninstall`\.$/m);
    assert.match(unit, /^Description=ASO worker \(Hub 192\.168\.1\.10\)$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/usr\/lib\/node_modules\/@aso\/cli\/dist\/aso\.mjs start-worker --hub 192\.168\.1\.10$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^Environment="PATH=\/home\/me\/\.nvm\/bin:\/usr\/bin"$/m);
    assert.match(unit, /^EnvironmentFile=\/home\/me\/\.config\/aso\/worker\.env$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(unit, /aso_/, "the token never goes into the unit file");
    assert.doesNotMatch(serviceUnit({ description: "d", installedBy: "aso hub-service", node: "n", script: "s", args: [], path: "/bin" }), /EnvironmentFile/);
  });

  it("knows when a .env file already provides the token", () => {
    assert.ok(envFilesSetToken(["X=1\nASO_TOKEN=aso_abc\n"], "aso_abc"));
    assert.ok(envFilesSetToken(['export ASO_TOKEN="aso_abc"'], "aso_abc"));
    assert.ok(!envFilesSetToken(["ASO_TOKEN=aso_old"], "aso_abc"), "a different token needs the service's own file");
    assert.ok(!envFilesSetToken(["# ASO_TOKEN=aso_abc", "MY_ASO_TOKEN=aso_abc"], "aso_abc"));
    assert.ok(!envFilesSetToken([], "aso_abc"));
  });

  it("gives the service its own token file only when the worker can't find the token itself", () => {
    const file = "/home/me/.config/aso/token";
    assert.equal(needsTokenEnvFile({ token: "aso_a", source: file }, file, []), false, "token file");
    assert.equal(needsTokenEnvFile({ token: "aso_a", source: "ASO_TOKEN" }, file, ["ASO_TOKEN=aso_a"]), false, ".env");
    assert.equal(needsTokenEnvFile({ token: "aso_a", source: "ASO_TOKEN" }, file, []), true, "shell variable only");
    assert.equal(needsTokenEnvFile({ token: "aso_b", source: "--token" }, file, ["ASO_TOKEN=aso_a"]), true, "--token differs from .env");
  });

  it("lives in the user's systemd directory", () => {
    assert.equal(userUnitDir({ XDG_CONFIG_HOME: "/x/cfg" }), "/x/cfg/systemd/user");
  });
});

describe("Hub service arguments", () => {
  /** A command shaped like start-hub's options, parsed from `argv`. */
  const parsed = (argv: string[], env: { ASO_MODEL?: string } = {}) => {
    const cmd = new Command()
      .exitOverride()
      .option("-r, --root <dir>", "projects", "/home/me/aso-projects")
      .option("-p, --port <port>", "port", Number, 7420)
      .option("--no-push", "keep merges local")
      .option("--docker", "docker", false)
      .option("--model <id>", "model", env.ASO_MODEL || "claude-opus-5-5")
      .option("--allow-deps <list>", "deps");
    cmd.parse(argv, { from: "user" });
    return cmd;
  };

  it("keeps only the options given on the command line, so defaults and .env values stay live", () => {
    assert.deepEqual(explicitArgs(parsed([])), []);
    assert.deepEqual(explicitArgs(parsed(["--docker", "--no-push", "-p", "7500", "--allow-deps", "zod,@types/*"])), [
      "--port", "7500", "--no-push", "--docker", "--allow-deps", "zod,@types/*",
    ]);
    assert.deepEqual(explicitArgs(parsed([], { ASO_MODEL: "claude-sonnet-5-5" })), [], "an env default is read again at start");
  });

  it("always passes the options it is told to, even from a default", () => {
    assert.deepEqual(explicitArgs(parsed([]), { always: ["root"] }), ["--root", "/home/me/aso-projects"]);
    assert.deepEqual(explicitArgs(parsed(["--root", "/srv/p", "--docker"]), { always: ["root"] }), ["--root", "/srv/p", "--docker"]);
  });

  it("rewrites a value by option name, whatever the values around it", () => {
    const upper = { map: { root: (v: string) => v.toUpperCase() } };
    assert.deepEqual(explicitArgs(parsed(["--model", "--root", "--root", "/srv/p"]), upper), ["--root", "/SRV/P", "--model", "--root"]);
  });
});

describe("runsAsSystemdService", () => {
  it("is true only for the unit's own main process", () => {
    assert.equal(runsAsSystemdService({ SYSTEMD_EXEC_PID: "4242" }, 4242), true);
    assert.equal(runsAsSystemdService({ SYSTEMD_EXEC_PID: "100" }, 4242), false, "a shell in a desktop's unit inherits another pid");
    assert.equal(runsAsSystemdService({}, 4242), false);
  });
});
