import {
  App,
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

    this.addRibbonIcon("tablet", "Push current note to reMarkable", () => {
      void this.pushActiveNote();
    });

    this.addCommand({
      id: "push-current-note",
      name: "Push current note to reMarkable",
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
    this.statusBar.setText("reMark: …");
    this.statusBar.addClass("mod-clickable");
    this.statusBar.addEventListener("click", () => {
      void this.refreshStatus();
    });

    this.addSettingTab(new RemarkBridgeSettingTab(this.app, this));

    // Poll every 60s once the plugin loads. The first tick fires
    // immediately so the status bar doesn't show a stale "..."
    // until the next interval.
    void this.refreshStatus();
    this.statusTimer = window.setInterval(() => {
      void this.refreshStatus();
    }, 60_000);
    this.registerInterval(this.statusTimer);
  }

  onunload() {
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
        return (resp.json ?? JSON.parse(resp.text || "{}")) as T;
      } catch (err) {
        lastError = err;
        if (attempt < attempts - 1) {
          const wait = this.settings.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, wait));
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
      new Notice("reMark: no active note to push");
      return;
    }

    if (!this.settings.apiToken) {
      new Notice("reMark: set a bridge token in plugin settings first");
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
        new Notice(`reMark: queued "${active.basename}" for push`);
      } else {
        new Notice(`reMark: push rejected — ${JSON.stringify(data)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`reMark: push failed — ${message}`);
    }
  }

  async refreshStatus() {
    if (!this.statusBar) return;

    if (!this.settings.apiToken) {
      this.statusBar.setText("reMark: no token");
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

      let label = `reMark: ${sync.synced ?? 0} synced`;
      if (pending) label += ` · ${pending} pending`;
      if (failed) label += ` · ⚠ ${failed} failed`;
      this.statusBar.setText(label);
    } catch {
      this.statusBar.setText("reMark: offline");
    }
  }
}

class RemarkBridgeSettingTab extends PluginSettingTab {
  plugin: RemarkBridgePlugin;

  constructor(app: App, plugin: RemarkBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("reMark Bridge").setHeading();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Where the reMark Bridge web service is running. Include the scheme and port.")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8000")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc(
        "Issue a token on the server with `remark-bridge bridge-token issue --label obsidian`.",
      )
      .addText((text) =>
        text
          .setPlaceholder("paste the bearer token here")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Retry attempts")
      .setDesc("Number of times a failing request is retried before giving up.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 6, 1)
          .setValue(this.plugin.settings.retryAttempts)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.retryAttempts = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Retry initial delay (ms)")
      .setDesc("First retry waits this long; subsequent retries double the delay.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.retryDelayMs))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.retryDelayMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
