import { fsFor } from "./extract-asar.js";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as updater from "./update.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import {
  GLOBAL_PROMPT_ORDER,
  isMnemonPluginMessage,
  rewritePromptAssembly,
} from "./identity.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as uninstaller from "./uninstall.js";

export const name = "dsh-purge";

export const inject = ["systemPrompt", "tools"];

let bootFullQuit = false;

const DEFAULTS = {
  enabled: true,
  autoApplyOnStart: true,
  autoUpdateOnStart: true,
  autoRevertOnMissing: false,
  injectOnce: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  autoRetry: true,
  retryMax: 3,
  autoContinue: true,
  continueMax: 3,
  continueText: "继续",
};

const log = (config, ...args) => {
  if (config?.verbose) console.log("[dsh-purge]", ...args);
};

let webTreeReady = false;
let continueRuntime = null;
let savedContinueSettings = {};
let continuePluginCfg = { ...DEFAULTS };

function currentContinueConfig() {
  return continueRetry.mergeConfig(continuePluginCfg, savedContinueSettings);
}

function continueStatusPayload(ctx, sessionId) {
  const cfg = currentContinueConfig();
  const agent = sessionId ? continueRetry.resolveAgent(ctx, sessionId) : null;
  if (agent && continueRuntime) return continueRuntime.status(agent);
  return {
    ok: true,
    sessionId: sessionId || "",
    canContinue: false,
    reason: "",
    userAbort: false,
    retryUsed: 0,
    continueUsed: 0,
    retryMax: cfg.retryMax,
    continueMax: cfg.continueMax,
    autoRetry: cfg.autoRetry,
    autoContinue: cfg.autoContinue,
    continueText: cfg.continueText,
  };
}

function watchWebTreeReady(ctx) {
  // 必须挂在 connection 上再 await，与官方打印 URL 同一时刻。
  // apply() 里立刻 await 会在后续入口尚未入树时提前结束，session.list 仍是空的。
  const mark = () => {
    webTreeReady = true;
  };
  if (typeof ctx?.inject !== "function") {
    mark();
    return;
  }
  try {
    ctx.inject(["connection"], (host) => {
      const settled = host.get?.("loader")?.await?.();
      if (!settled || typeof settled.then !== "function") {
        mark();
        return;
      }
      settled.then(() => {
        if (host.get?.("webServer") !== undefined && host.get?.("connection") !== undefined) mark();
      }, mark);
    });
  } catch {
    mark();
  }
}

function fsExists(fp) {
  return fsFor(fp).existsSync(fp);
}

function line(title, value, ok = null) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  return `${mark} ${title}: ${value}`;
}

function renderStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push(line("宿主 / surface", state.surface || hostctl.currentSurface()));
  out.push(line("DSH_HOME", state.dsh_home));
  if (state.desktop_install) out.push(line("桌面安装 / desktop", state.desktop_install));
  if (state.ai_base) {
    out.push(line("插件根 / plugin root", state.ai_base));
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${fsExists(fp) ? "✓" : "✗"} ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push(line("插件根 / plugin root", core.missingAiBaseMessage(), false));
  }
  out.push(line("shim 目录", state.shim_dir || "未定位 / not found", !!state.shim_dir));
  if (state.desktop_runtimes?.length) {
    out.push(line("Desktop runtime", `${state.desktop_runtimes.length} sealed (shim OK; bak external)`, true));
    for (const d of state.desktop_runtimes) out.push(`    · ${d}`);
  }
  out.push(line("备份 / backup", state.has_backup ? "有 / yes" : "无 / no", state.has_backup));
  out.push(line("注入文件 / inject", state.override_path));
  out.push(line("注入状态 / override", state.override_status));
  out.push("");
  out.push(`补丁 / patches: ${state.patches_applied}/${core.ALL_PATCHES.length} applied, ${state.patches_pending} pending`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`  ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function injectAllowedNow(config) {
  return config.enabled !== false;
}

function injectSnapshot(dshHome = core.findDshHome()) {
  const hasPrompt = Boolean(core.normalizeOverride(core.readOverrideText(dshHome)));
  return {
    injectSource: hasPrompt ? "prompt" : "none",
    injectRuleId: null,
    needPrompt: !hasPrompt,
  };
}

/** 以设置页文本框为准；空框时按磁盘上的提示词文件判断。 */
function injectSnapshotFromBox(dshHome, boxText) {
  if (typeof boxText === "string" && core.normalizeOverride(boxText)) {
    return { injectSource: "prompt", injectRuleId: null, needPrompt: false };
  }
  return injectSnapshot(dshHome);
}

const NEED_PROMPT_ERROR = "提示词是空的，请先在设置页填写提示词";

function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

export function registerPromptSections(ctx, config, _injectFile) {
  ctx.systemPrompt.section({
    name: "dsh-purge",
    order: GLOBAL_PROMPT_ORDER,
    text: () => {
      if (!injectAllowedNow(config)) return "";
      return core.readOverrideText(core.findDshHome());
    },
  });

  ctx.systemPrompt.section({
    name: "dsh-purge:rules",
    order: GLOBAL_PROMPT_ORDER + 10,
    text: () => (injectAllowedNow(config) ? core.ALLOW_EXEC_CORE : ""),
  });

  const postPrompt = typeof config.postPrompt === "string" ? config.postPrompt.trim() : "";
  if (!postPrompt) return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    throw new TypeError(`postPromptOrder must be a finite number greater than ${GLOBAL_PROMPT_ORDER}`);
  }
  ctx.systemPrompt.section({
    name: "dsh-purge:post",
    order: config.postPromptOrder,
    text: () => (injectAllowedNow(config) ? postPrompt : ""),
  });
}

function readInjectFallback() {
  return core.readOverrideText(core.findDshHome());
}

function installMnemonMessageStrip(ctx, config = {}) {
  if (config.stripMnemon === false) return;
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeMnemonStrip) return;
  ctx.__dshPurgeMnemonStrip = true;
  const wrap = async (_payload, next) => {
    const decision = await next();
    if (!decision || !Array.isArray(decision.messages)) return decision;
    const messages = decision.messages.filter((message) => !isMnemonPluginMessage(message));
    if (messages.length === decision.messages.length) return decision;
    return { ...decision, messages };
  };
  const late = () => {
    try {
      ctx.on("agent/pre-step", wrap, { global: true, prepend: true });
    } catch {}
  };
  late();
  queueMicrotask(late);
  setTimeout(late, 1500);
}

function rewriteLiveAssembly(config, assembled, context) {
  const enabled = config.enabled !== false;
  const inject = enabled ? readInjectFallback() : "";
  return rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon !== false,
    dropPurgeAfterFold: false,
    context,
  });
}

function installIdentityOverride(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeAssembleHook) return;
  ctx.__dshPurgeAssembleHook = true;
  const hook = async (_assembly, context, next) => {
    const assembled = typeof next === "function" ? await next() : _assembly;
    return rewriteLiveAssembly(config, assembled, context);
  };
  // 只挂一次。不改 contexts，不改 pre-step 白名单，梁神 phase-1 和其它插件的消息原样保留。
  ctx.on("system-prompt/assemble", hook, { global: true, prepend: true });
  // 0.1.5 起 complete:true 在 waterfall 之后用调用前的快照盖掉 sections。
  // 换宿主版本时文件补丁还没写上，或换插件版本时旧钩子把 dsh-purge 段删掉，注入都会丢。
  // 包住 assemble 的返回值，按 prompt-inject.md 再补回。
  const prompt = ctx.systemPrompt;
  if (!prompt || typeof prompt.assemble !== "function" || prompt.__dshPurgeAssembleWrapped) return;
  const orig = prompt.assemble;
  prompt.assemble = async function (...args) {
    const assembled = await orig.apply(this, args);
    return rewriteLiveAssembly(config, assembled, args[0]);
  };
  prompt.__dshPurgeAssembleWrapped = true;
}

function shimNeedsPatch(state) {
  if (hostctl.currentSurface() === "desktop") return false;
  return (
    state.shim_cmd === "original" ||
    state.shim_ps1 === "original" ||
    state.shim_bin === "original"
  );
}

async function settleInstalledPatches(config, ctx) {
  if (officialUpdate.upgradeMarkerExists(process.execPath)) {
    const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, forceExtract: true });
    officialUpdate.clearUpgradeMarker(process.execPath);
    if (!upgraded.ok) {
      log(config, "official upgrade reapply failed:", upgraded.error || "");
      return "reapply-failed";
    }
    officialUpdate.clearStaleExtractedApps(process.execPath);
    log(config, "official upgrade reapplied; restarting onto the new build");
    try {
      hostctl.scheduleRestart(null, ctx);
    } catch (e) {
      log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }
  if (!reapply.patchesMatchInstall()) {
    const result = await reapply.reapplyInstalled();
    if (!result.ok) {
      log(config, "reapply failed:", result.error || "");
      return "reapply-failed";
    }
    if (result.needsFullQuit) {
      bootFullQuit = true;
      log(config, "reapply wrote patches; official host needs a full quit");
      return "full-quit";
    }
    log(config, "reapply wrote patches; restarting");
    try {
      hostctl.scheduleRestart(null, ctx);
    } catch (e) {
      log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }
  const applied = await autoApply(config);
  if (config.autoUpdateOnStart !== false) {
    updater.autoUpdateIfNeeded()
      .then((r) => {
        log(config, "auto-update:", JSON.stringify(r));
        if (r && r.needsFullQuit) bootFullQuit = true;
        if (r && r.restartAfter) {
          try { hostctl.scheduleRestart(null, ctx); } catch (e) {
            console.warn("[dsh-purge] auto-update restart failed:", e);
          }
        }
      })
      .catch((e) => console.warn("[dsh-purge] auto-update error:", String(e)));
  }
  return applied;
}

async function autoApply(config) {
  try {
    core.applyRuntimeEnv();
    const sanitized = core.sanitizeDesktopCommandRuntimes();
    if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

    const state = await core.gatherState();
    await core.installOverride(state.dsh_home, false);
    if (!state.ai_base) {
      log(config, "skip auto-apply: plugin root not found");
      return "skip:plugin_root_not_found";
    }
    try {
      const flash = core.silenceCmdFlash(state.ai_base);
      log(config, "cmd-flash:", JSON.stringify(flash));
      if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
    } catch (e) {
      log(config, "cmd-flash failed:", String(e));
    }

    if (state.patches_pending === 0) {
      if (config.autoApplyOnStart && shimNeedsPatch(state)) {
        await core.patchAllShims();
        core.silenceCmdFlash(state.ai_base);
        log(config, "auto-apply: patches clean, shim refreshed");
        return "already_clean:shim_patched";
      }
      log(config, "auto-apply: already clean");
      return "already_clean";
    }
    if (!config.autoApplyOnStart) {
      log(config, "auto-apply disabled");
      return "disabled";
    }
    await core.backupAll(state.ai_base);
    const report = await core.applyPatches(state.ai_base);
    await core.patchAllShims();
    const flash = core.silenceCmdFlash(state.ai_base);
    const applied = report.filter((r) => r.status === "applied").length;
    log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
    return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
  } catch (e) {
    console.warn("[dsh-purge] auto-apply error:", String(e));
    return `error:${e}`;
  }
}

async function handlePurgeCommand(rawInput, config) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "status").toLowerCase();

  switch (sub) {
    case "status":
    case "s": {
      const state = await core.gatherState();
      return { kind: "success", text: renderStatus(state) };
    }
    case "apply":
    case "a": {
      core.applyRuntimeEnv();
      const scrubbed = core.sanitizeDesktopCommandRuntimes();
      const state = await core.gatherState();
      let handoff = null;
      if (!state.ai_base) {
        const opened = await core.openSealedDesktopHost();
        if (!opened.aiBase) return { kind: "error", text: core.missingAiBaseMessage() };
        state.ai_base = opened.aiBase;
        if (opened.swapAsar) handoff = opened;
      } else {
        handoff = core.sealedAsarHandoff();
      }
      const blocked = rejectIfNeedPrompt(state.dsh_home);
      if (blocked) return { kind: "error", text: blocked.error };
      await core.backupAll(state.ai_base);
      const report = await core.applyPatches(state.ai_base);
      const shimResult = await core.patchAllShims();
      const flash = core.silenceCmdFlash(state.ai_base);
      const lines = report.map((r) => {
        const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
        return `  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`;
      });
      lines.push("", "shim:");
      for (const [dir, st] of Object.entries(shimResult)) {
        lines.push(`  · ${dir} → ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push(`  cmd-flash=${flash.entry} ok=${flash.ok}`);
      if (scrubbed.length) {
        lines.push("", "Desktop in-bin .bak scrub:");
        for (const row of scrubbed) lines.push(`  ✓ ${row.dir} → ${row.cleaned.join(", ")}`);
      }
      lines.push("", "全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
      lines.push("Desktop: host-commands 密封目录只清理不注入；bak 禁止写进 bin（issue #9）。");
      if (handoff) {
        const swapped = core.scheduleSealedDesktopRestart(handoff);
        if (swapped?.renamed || swapped?.pending) {
          lines.push("", "补丁已写入。请在设置页点「重启」，客户端会自己重新打开。");
        }
      }
      return { kind: "success", text: lines.join("\n") };
    }
    case "revert":
    case "r": {
      const state = await core.gatherState();
      const lines = [];
      if (state.ai_base) {
        const { reverted, errors } = await core.revertAll(state.ai_base);
        lines.push(...reverted.map((p) => `  ✓ 已还原 / Reverted ${p}`));
        for (const [p, e] of errors) lines.push(`  ⚠ 还原失败 ${p}: ${e}`);
        if (reverted.length === 0) lines.push("  - 没有补丁备份可还原 / no patch backup");
      }
      const shimRevert = await core.revertAllShims();
      for (const [dir, st] of Object.entries(shimRevert)) {
        lines.push(`  shim ${dir}: ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push("", "回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
      lines.push("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
      return { kind: "success", text: lines.join("\n") };
    }
    case "uninstall":
    case "remove": {
      const result = await uninstaller.uninstallPurge();
      const lines = [];
      if (result.applied) lines.push("已检测到补丁，已还原回原版。");
      else lines.push("未检测到已应用补丁，仍会清除插件文件。");
      if (result.patches) {
        lines.push(`  还原文件 ${result.patches.reverted?.length || 0} 个`);
      }
      if (result.override?.removed) lines.push(`  已删除 ${result.override.path}`);
      if (result.stripped?.length) lines.push(`  已从 profile 移除: ${result.stripped.join(", ")}`);
      if (result.errors?.length) {
        for (const e of result.errors) lines.push(`  ⚠ ${e}`);
      }
      lines.push("", "请重启 dsh。重启后插件不再加载。");
      return { kind: result.ok ? "success" : "error", text: lines.join("\n") };
    }
    case "edit":
    case "e": {
      const state = await core.gatherState();
      const r = core.editOverride(state.dsh_home);
      if (!r.ok && r.needCreate) {
        await core.installOverride(state.dsh_home, true);
        const r2 = core.editOverride(state.dsh_home);
        return {
          kind: "success",
          text: `已创建默认注入文件并打开编辑器：${r2.path}\n重启 dsh 生效。`,
        };
      }
      return {
        kind: "success",
        text: `已打开 ${r.editor} 编辑注入文件：${r.path}\n编辑完成后重启 dsh 生效。`,
      };
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "dsh-purge 命令：\n" +
          "  /purge status     显示状态\n" +
          "  /purge apply      应用全部清洗（提示词+代码+shim+override）\n" +
          "  /purge revert     回滚还原\n" +
          "  /purge uninstall  卸载插件（已应用则先还原）\n" +
          "  /purge edit       编辑注入文件 prompt-inject.md\n" +
          "  /purge help       显示帮助\n" +
          "规则集切换见 /rules（list | use <id> | create | delete | reset）\n" +
          "官方 Skill 安装见 /skills（list | import <路径> | create <id> [说明] | delete <id>）",
      };
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) return;
  log(cfg, "plugin enabled");

  try {
    const hide = core.ensureHiddenConsole();
    log(cfg, "hide-console:", JSON.stringify(hide));
  } catch (e) {
    console.warn("[dsh-purge] hide-console error:", String(e));
  }
  core.applyRuntimeEnv();
  try {
    const scrubbed = core.sanitizeDesktopCommandRuntimes();
    if (scrubbed.length) log(cfg, "desktop runtime scrub on load:", JSON.stringify(scrubbed));
  } catch (e) {
    console.warn("[dsh-purge] desktop runtime scrub error:", String(e));
  }

  setImmediate(() => {
    settleInstalledPatches(cfg, ctx)
      .then((r) => log(cfg, "settle:", r))
      .catch((e) => console.warn("[dsh-purge] settle error:", String(e)));
  });

  try {
    core.seedOverrideSync(core.findDshHome());
  } catch (e) {
    console.warn("[dsh-purge] seed override error:", String(e));
  }
  installIdentityOverride(ctx, cfg);
  installMnemonMessageStrip(ctx, cfg);
  const injectFile = core.findOverrideFile(core.findDshHome());
  registerPromptSections(ctx, cfg, injectFile);

  // 继续/重试先关掉，需要时再打开下面这段。
  // continuePluginCfg = cfg;
  // savedContinueSettings = continueRetry.loadSettings(core.findDshHome());
  // try { continueRuntime?.dispose?.(); } catch { /* ignore */ }
  // continueRuntime = continueRetry.installContinueRetry(ctx, { getConfig: currentContinueConfig });

  const commands = ctx.get?.("commands");
  if (commands) {
    commands.register({
      name: "purge",
      description: "dsh 指令权威性清洗（status/apply/revert/uninstall/edit/help）",
      input: { hint: "status | apply | revert | uninstall | edit | help" },
      handler: async (invocation) => handlePurgeCommand(invocation.rawInput ?? "", cfg),
    });
    commands.register({
      name: "rewind",
      description: "回退：子代理直接回退一次；主代理 /rewind once 或 /rewind round",
      input: { hint: "once | round" },
      handler: async (invocation) => {
        const sessionId = rewind.invocationSessionId(invocation);
        const arg = String(invocation.rawInput || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
        const info = await rewind.analyzeRewind(ctx, sessionId);
        if (info.ok && info.kind === "main" && arg !== "once" && arg !== "round") {
          return {
            kind: "success",
            text: "主代理请选择：/rewind once 回退一次，/rewind round 回退上一轮（含本轮子代理）。",
          };
        }
        const mode = arg === "round" ? "round" : "once";
        const result = await rewind.applyRewind(ctx, sessionId, mode);
        if (!result.ok) return { kind: "error", text: result.error };
        return {
          kind: "success",
          text: mode === "round"
            ? "已回退上一轮。正在打开新的主会话，上一句已填回输入框。"
            : "已回退一次。正在打开新会话，上一句已填回输入框。",
        };
      },
    });
    // commands.register({
    //   name: "continue",
    //   description: "异常停止或中断后发送继续（计入继续次数）",
    //   input: { hint: "继续当前异常停止的会话" },
    //   handler: async (invocation) => {
    //     const sessionId = rewind.invocationSessionId(invocation);
    //     const agent = continueRetry.resolveAgent(ctx, sessionId);
    //     if (!agent || !continueRuntime) return { kind: "error", text: "当前会话不能继续" };
    //     const result = continueRuntime.continueNow(agent);
    //     if (!result.ok) return { kind: "error", text: result.error };
    //     return { kind: "success", text: `已发送继续（${result.used}/${result.max}）` };
    //   },
    // });
  }

  if (ctx.tools) {
    ctx.tools.register({
      name: "purge_status",
      description: `查看 dsh 指令权威性清洗状态（${core.ALL_PATCHES.length} patch 清洗进度、shim 注入、override 文件）。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        return { text: renderStatus(state) };
      },
    });
    ctx.tools.register({
      name: "purge_apply",
      description: `应用 dsh 指令权威性清洗：${core.ALL_PATCHES.length} patch（提示词层+代码默认+引擎级审批/沙箱绕过）+ shim 注入 + override 文件。需重启 dsh 完全生效。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        core.applyRuntimeEnv();
        const scrubbed = core.sanitizeDesktopCommandRuntimes();
        const state = await core.gatherState();
        if (!state.ai_base) return { text: "ERROR: " + core.missingAiBaseMessage() };
        const blocked = rejectIfNeedPrompt(state.dsh_home);
        if (blocked) return { text: "ERROR: " + blocked.error };
        await core.backupAll(state.ai_base);
        const report = await core.applyPatches(state.ai_base);
        await core.patchAllShims();
        const flash = core.silenceCmdFlash(state.ai_base);
        const applied = report.filter((r) => r.status === "applied").length;
        const already = report.filter((r) => r.status === "already").length;
        const scrubNote = scrubbed.length ? ` desktop_scrub=${scrubbed.length}` : "";
        return { text: `清洗完成 / applied=${applied}, already=${already}.${scrubNote} 重启 dsh 生效.` };
      },
    });
    ctx.tools.register({
      name: "purge_revert",
      description: "回滚 dsh 指令权威性清洗到备份原件（保留 prompt-inject.md 用户文件）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        const lines = [];
        if (state.ai_base) {
          const { reverted, errors } = await core.revertAll(state.ai_base);
          lines.push(`reverted=${reverted.length}${errors.length ? ` errors=${errors.length}` : ""}`);
        }
        const shimRevert = await core.revertAllShims();
        lines.push(`shim_dirs=${Object.keys(shimRevert).length}`);
        return { text: `回滚完成 / ${lines.join(", ")}. 重启 dsh 恢复.` };
      },
    });
  }

  installWebServer(ctx, cfg);
}

function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function denyCrossOrigin(response) {
  response.writeHead(403, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, error: "cross-origin blocked" }));
}

function allowPluginRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  if (site === "cross-site") {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, "origin").trim();
  if (origin === "null") {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, "host").trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

function installWebServer(ctx, cfg) {
  // 桌面端内嵌 @deepseek-ai/dsh-web-app，设置页同样走 webServer（常见 43120），不是只给官方 dsh web。
  watchWebTreeReady(ctx);
  ctx.inject(["webServer", "connection"], (host) => {
    // [local security patch] Every panel route goes through the same signed
    // cookie + Host/Origin check the DSH API uses. Upstream's allowPluginRequest
    // returns true when a request carries NO Origin header at all, so any
    // non-browser client (curl, a LAN script) reached /dsh-purge/apply,
    // /override, /uninstall and the rules/skills routes unchecked.
    const webServer = {
      register(route, label) {
        return host.webServer.register({
          ...route,
          handler(request, response) {
            const rejection = host.connection.requestRejection(request);
            if (rejection !== undefined) {
              sendJson(response, rejection, {
                ok: false,
                error: rejection === 401 ? "unauthorized" : "forbidden",
              });
              return;
            }
            return route.handler(request, response);
          },
        }, label);
      },
    };
    host.effect(() => {
      const registerPluginRoute = (spec, label) => webServer.register({
        ...spec,
        handler: async (request, response) => {
          if (!allowPluginRequest(request, response)) return;
          return spec.handler(request, response);
        },
      }, label);
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            if (!webTreeReady) {
              sendJson(response, 503, { ok: false, ready: false });
              return;
            }
            const state = await core.gatherState();
            const patch_names = {};
            for (const p of core.ALL_PATCHES) patch_names[String(p.id)] = p.name;
            sendJson(response, 200, {
              ok: true,
              ready: true,
              surface: state.surface || hostctl.currentSurface(),
              ai_base: state.ai_base,
              desktop_install: state.desktop_install || "",
              missing_ai_base: state.ai_base ? "" : core.missingAiBaseMessage(),
              patches_applied: state.patches_applied,
              patches_pending: state.patches_pending,
              patches_skipped: state.patches_skipped || 0,
              patches_total: core.ALL_PATCHES.length,
              patch_status: state.patch_status,
              patch_names,
              shim_cmd: state.shim_cmd,
              shim_ps1: state.shim_ps1,
              shim_bin: state.shim_bin,
              has_backup: state.has_backup,
              override_status: state.override_status,
              override_path: state.override_path,
              dsh_home: state.dsh_home,
              plugin_version: updater.localVersion(),
              boot_full_quit: bootFullQuit,
              update: updater.lastUpdateResult(),
              ...updater.channelPublic(),
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: status");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/last-user",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.readLastUserText(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: last user");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind/options",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.analyzeRewind(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: rewind options");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const url = new URL(request.url, "http://127.0.0.1");
              const sessionId = url.searchParams.get("sessionId");
              if (sessionId) {
                const draft = rewind.takeDraft(sessionId);
                sendJson(response, 200, { ok: true, ...(draft || {}) });
                return;
              }
              const pending = rewind.getPending();
              sendJson(response, 200, { ok: true, ...(pending || {}) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const sessionId = String(body?.sessionId || "").trim();
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "需要 sessionId" });
                return;
              }
              const mode = body?.mode === "round" ? "round" : "once";
              const result = await rewind.applyRewind(ctx, sessionId, mode);
              sendJson(response, result.ok ? 200 : 409, result);
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: rewind");
      // registerPluginRoute({
      //   kind: "exact",
      //   path: "/dsh-purge/continue",
      //   handler: async (request, response) => {
      //     if (request.method === "GET") {
      //       try {
      //         const url = new URL(request.url, "http://127.0.0.1");
      //         const sessionId = String(url.searchParams.get("sessionId") || "").trim();
      //         sendJson(response, 200, continueStatusPayload(ctx, sessionId));
      //       } catch (e) {
      //         sendJson(response, 500, { ok: false, error: String(e) });
      //       }
      //       return;
      //     }
      //     if (request.method === "POST") {
      //       try {
      //         const body = await readJsonBody(request);
      //         const sessionId = String(body?.sessionId || "").trim();
      //         if (!sessionId) {
      //           sendJson(response, 400, { ok: false, error: "需要 sessionId" });
      //           return;
      //         }
      //         const agent = continueRetry.resolveAgent(ctx, sessionId);
      //         if (!agent || !continueRuntime) {
      //           sendJson(response, 409, { ok: false, error: "当前会话不能继续" });
      //           return;
      //         }
      //         const result = continueRuntime.continueNow(agent, { force: Boolean(body?.force) });
      //         sendJson(response, result.ok ? 200 : 409, result);
      //       } catch (e) {
      //         sendJson(response, 500, { ok: false, error: String(e) });
      //       }
      //       return;
      //     }
      //     response.writeHead(405, { allow: "GET, POST" });
      //     response.end();
      //   },
      // }, "dsh-purge: continue");
      // registerPluginRoute({
      //   kind: "exact",
      //   path: "/dsh-purge/continue/settings",
      //   handler: async (request, response) => {
      //     if (request.method === "GET") {
      //       try {
      //         sendJson(response, 200, { ok: true, ...currentContinueConfig() });
      //       } catch (e) {
      //         sendJson(response, 500, { ok: false, error: String(e) });
      //       }
      //       return;
      //     }
      //     if (request.method === "POST") {
      //       try {
      //         const body = await readJsonBody(request);
      //         savedContinueSettings = await continueRetry.saveSettings(core.findDshHome(), {
      //           ...currentContinueConfig(),
      //           ...body,
      //         });
      //         sendJson(response, 200, { ok: true, ...currentContinueConfig() });
      //       } catch (e) {
      //         sendJson(response, 500, { ok: false, error: String(e) });
      //       }
      //       return;
      //     }
      //     response.writeHead(405, { allow: "GET, POST" });
      //     response.end();
      //   },
      // }, "dsh-purge: continue settings");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/update",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              sendJson(response, 200, await updater.checkUpdate());
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const result = await updater.handleUpdateOp(body || {});
              if (result && result.needsFullQuit) bootFullQuit = true;
              sendJson(response, 200, result);
              if (result && result.restartAfter) {
                try { hostctl.scheduleRestart(request, ctx); } catch (e) {
                  console.warn("[dsh-purge] update restart failed:", e);
                }
              }
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: update");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/apply",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            core.applyRuntimeEnv();
            const scrubbed = core.sanitizeDesktopCommandRuntimes();
            const state = await core.gatherState();
            let handoff = null;
            if (!state.ai_base) {
              const opened = await core.openSealedDesktopHost();
              if (!opened.aiBase) {
                sendJson(response, 500, { ok: false, error: core.missingAiBaseMessage() });
                return;
              }
              state.ai_base = opened.aiBase;
              if (opened.swapAsar) handoff = opened;
            } else {
              handoff = core.sealedAsarHandoff();
            }
            const body = await readJsonBody(request);
            const ui = await core.readOverrideForUi(state.dsh_home);
            const boxText = typeof body?.content === "string" ? body.content : ui.content;
            const blocked = rejectIfNeedPrompt(state.dsh_home, boxText);
            if (blocked) {
              sendJson(response, 400, {
                ok: false,
                needPrompt: true,
                override_content: boxText,
                defaultContent: ui.defaultContent,
                ...blocked,
              });
              return;
            }
            if (typeof body?.content === "string") {
              await core.saveOverrideContent(state.dsh_home, body.content);
            }
            await core.backupAll(state.ai_base);
            const report = await core.applyPatches(state.ai_base);
            const override = await core.readOverrideForUi(state.dsh_home);
            const shim = await core.patchAllShims();
            const flash = core.silenceCmdFlash(state.ai_base);
            const summary = core.summarizeApplyReport(report);
            const complete = summary.failed.length === 0 && flash.ok === true;
            let renamed = false;
            let pendingQuit = false;
            if (handoff) {
              const swapped = core.scheduleSealedDesktopRestart(handoff);
              renamed = Boolean(swapped?.renamed);
              pendingQuit = Boolean(swapped?.pending);
            }
            const leaveTray = renamed || pendingQuit;
            sendJson(response, 200, {
              ok: true,
              complete,
              restarting: false,
              unpacked_asar: leaveTray,
              needs_full_quit: leaveTray,
              applied: summary.applied,
              already: summary.already,
              failed: summary.failed.length,
              failed_items: summary.failed.map((r) => ({
                id: r.patch_id,
                name: r.name,
                status: r.status,
              })),
              report: report.map((r) => ({ id: r.patch_id, name: r.name, status: r.status })),
              override_content: override.content,
              defaultContent: override.defaultContent,
              ...injectSnapshot(state.dsh_home),
              override_path: override.path,
              override_installed: override.installed,
              shim,
              desktop_scrubbed: scrubbed,
              cmd_flash: flash,
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: apply");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/revert",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const state = await core.gatherState();
            const result = {};
            if (state.ai_base) {
              const { reverted, errors } = await core.revertAll(state.ai_base);
              result.reverted = reverted.length;
              result.errors = errors.length;
            }
            result.shim = await core.revertAllShims();
            sendJson(response, 200, { ok: true, ...result, note: "重启 dsh 恢复; prompt-inject.md 保留" });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: revert");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/uninstall",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const result = await uninstaller.uninstallPurge();
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface: hostctl.currentSurface(),
              fullApp: hostctl.currentSurface() === "desktop",
              note: result.ok ? hostctl.restartNote() : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      }, "dsh-purge: uninstall");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/override",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const home = core.findDshHome();
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, { ok: true, ...ui, ...injectSnapshot(home) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const home = core.findDshHome();
              const blocked = rejectIfNeedPrompt(home, content);
              if (blocked) {
                sendJson(response, 400, {
                  ok: false,
                  content,
                  ...blocked,
                });
                return;
              }
              const saved = await core.saveOverrideContent(home, content);
              sendJson(response, 200, { ok: true, ...saved, ...injectSnapshot(home) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: override");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/restart",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const surface = hostctl.currentSurface();
            const planned = hostctl.scheduleRestart(request, ctx);
            sendJson(response, 200, {
              ok: true,
              surface,
              fullApp: surface === "desktop",
              restarting: Boolean(planned && planned.restarting),
              needsFullQuit: false,
              note: "正在重启。",
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: restart");
    }, "dsh-purge: http routes");
  });
}

function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(", ") });
  response.end();
  return true;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function registerRoute(webServer, spec) {
  try {
    const handler = spec.handler;
    return webServer.register({
      ...spec,
      handler: async (request, response) => {
        if (!allowPluginRequest(request, response)) return;
        return handler(request, response);
      },
    });
  } catch (e) {
    console.warn("[dsh-purge] route", spec?.path, String(e && e.message ? e.message : e));
    return () => {};
  }
}

async function readJsonBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
