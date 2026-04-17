import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
  RequestUrlParam,
} from "obsidian";

interface RemarkBridgeSettings {
  serverUrl: string;
  apiToken: string;
  retryAttempts: number;
  retryDelayMs: number;
}

const DEFAULT_SETTINGS: RemarkBridgeSettings = {
  serverUrl: "http://localhost:8000",
  apiToken: "",
  retryAttempts: 3,
  retryDelayMs: 2000,
};

interface BridgeStatusResponse {
  sync?: { synced?: number };
  queue?: { failed?: number; pending?: number };
}

interface BridgePushResponse {
  queued?: boolean;
}

export default class RemarkBridgePlugin extends Plugin {
  settings: RemarkBridgeSettings = DEFAULT_SETTINGS;
  private statusBar: HTMLElement | null = null;
  private statusTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("tablet", "Push current note to tablet", () => {
      void this.pushActiveNote();
    });

    this.addCommand({
      id: "push-current-note",
      name: "Push current note to tablet",
      callback: () => {
        void this.pushActiveNote();
      },
    });

    this.addCommand({
      id: "refresh-status",
      name: "Refresh sync status",
      callback: () => {
        void this.refreshStatus();
      },
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Sync status unknown");
    this.statusBar.addClass("mod-clickable");
    this.statusBar.addEventListener("click", () => {
      void this.refreshStatus();
    });

    this.addSettingTab(new RemarkBridgeSettingTab(this.app, this));

    // Poll every 60s once the plugin loads. The first tick fires
    // immediately so the status bar doesn't show a stale placeholder
    // until the next interval.
    void this.refreshStatus();
    this.statusTimer = this.registerInterval(
      activeWindow.setInterval(() => {
        void this.refreshStatus();
      }, 60_000),
    );
  }

  onunload() {
    if (this.statusTimer !== null) {
      activeWindow.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<RemarkBridgeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private authHeader(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settings.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async bridgeRequest<T>(params: RequestUrlParam): Promise<T> {
    // Retry with a short exponential back-off. `requestUrl` already
    // times out internally, so the only failures we catch here are
    // genuine network / server errors.
    let lastError: unknown = null;
    const attempts = Math.max(1, this.settings.retryAttempts);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const resp = await requestUrl(params);
        if (resp.status >= 400) {
          throw new Error(`HTTP ${resp.status}: ${resp.text?.slice(0, 200) ?? ""}`);
        }
        const parsed: unknown = resp.json ?? JSON.parse(resp.text || "{}");
        return parsed as T;
      } catch (err) {
        lastError = err;
        if (attempt < attempts - 1) {
          const wait = this.settings.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => activeWindow.setTimeout(resolve, wait));
        }
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(
      typeof lastError === "string" ? lastError : "Bridge request failed",
    );
  }

  async pushActiveNote() {
    const active = this.app.workspace.getActiveFile();
    if (!active || !(active instanceof TFile)) {
      new Notice("No active note to push");
      return;
    }

    if (!this.settings.apiToken) {
      new Notice("Set a bridge token in plugin settings first");
      return;
    }

    try {
      const data = await this.bridgeRequest<BridgePushResponse>({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/api/push`,
        method: "POST",
        headers: this.authHeader(),
        body: JSON.stringify({ vault_path: active.path }),
        throw: false,
      });
      if (data?.queued) {
        new Notice(`Queued "${active.basename}" for push`);
      } else {
        new Notice(`Push rejected — ${JSON.stringify(data)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Push failed — ${message}`);
    }
  }

  async refreshStatus() {
    if (!this.statusBar) return;

    if (!this.settings.apiToken) {
      this.statusBar.setText("No bridge token set");
      return;
    }

    try {
      const data = await this.bridgeRequest<BridgeStatusResponse>({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/api/status`,
        method: "GET",
        headers: this.authHeader(),
        throw: false,
      });
      const sync = data?.sync ?? {};
      const queue = data?.queue ?? {};
      const failed = queue.failed ?? 0;
      const pending = queue.pending ?? 0;

      let label = `${sync.synced ?? 0} notes synced`;
      if (pending) label += ` · ${pending} pending`;
      if (failed) label += ` · ⚠ ${failed} failed`;
      this.statusBar.setText(label);
    } catch {
      this.statusBar.setText("Bridge offline");
    }
  }
}

class RemarkBridgeSettingTab extends PluginSettingTab {
  private get remarkPlugin(): RemarkBridgePlugin {
    return this.plugin as RemarkBridgePlugin;
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.remarkPlugin;
    containerEl.empty();

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Where the bridge web service is running. Include the scheme and port.")
      .addText((text) =>
        text
          .setValue(plugin.settings.serverUrl)
          .onChange(async (value) => {
            plugin.settings.serverUrl = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc(
        "Issue a token on the server with `remark-bridge bridge-token issue --label obsidian`.",
      )
      .addText((text) =>
        text
          .setValue(plugin.settings.apiToken)
          .onChange(async (value) => {
            plugin.settings.apiToken = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Retries").setHeading();

    new Setting(containerEl)
      .setName("Retry attempts")
      .setDesc("Number of times a failing request is retried before giving up.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 6, 1)
          .setValue(plugin.settings.retryAttempts)
          .setDynamicTooltip()
          .onChange(async (value) => {
            plugin.settings.retryAttempts = value;
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Retry initial delay (ms)")
      .setDesc("First retry waits this long; subsequent retries double the delay.")
      .addText((text) =>
        text
          .setValue(String(plugin.settings.retryDelayMs))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              plugin.settings.retryDelayMs = n;
              await plugin.saveSettings();
            }
          }),
      );
  }
}
