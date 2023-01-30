import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    workspace as Workspace,
    ExtensionContext,
    commands as Commands,
    TextDocument,
    Uri,
    window,
    Disposable,
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DocumentSelector,
    LSPAny,
    ExecuteCommandRequest,
} from 'vscode-languageclient/node';

export let defaultClient: LuaClient;

function registerCustomCommands(context: ExtensionContext) {
    context.subscriptions.push(Commands.registerCommand('lua.config', (changes) => {
        let propMap: Map<string, Map<string, any>> = new Map();
        for (const data of changes) {
            let config = Workspace.getConfiguration(undefined, Uri.parse(data.uri));
            if (data.action == 'add') {
                let value: any[] = config.get(data.key);
                value.push(data.value);
                config.update(data.key, value, data.global);
                continue;
            }
            if (data.action == 'set') {
                config.update(data.key, data.value, data.global);
                continue;
            }
            if (data.action == 'prop') {
                if (!propMap[data.key]) {
                    propMap[data.key] = config.get(data.key);
                }
                propMap[data.key][data.prop] = data.value;
                config.update(data.key, propMap[data.key], data.global);
                continue;
            }
        }
    }))
}

class LuaClient {

    public client: LanguageClient;
    private disposables = new Array<Disposable>();
    constructor(private context: ExtensionContext,
                private documentSelector: DocumentSelector) {
    }

    async start() {
        // Options to control the language client
        let clientOptions: LanguageClientOptions = {
            // Register the server for plain text documents
            documentSelector: this.documentSelector,
            progressOnInitialization: true,
            markdown: {
                isTrusted: true,
                supportHtml: true,
            },
            initializationOptions: {
                changeConfiguration: true,
            }
        };

        let config = Workspace.getConfiguration(undefined, vscode.workspace.workspaceFolders?.[0]);
        let commandParam: string[] = config.get("Lua.misc.parameters");
        let command: string = await this.getCommand(config);

        let serverOptions: ServerOptions = {
            command: command,
            args:    commandParam,
        };

        this.client = new LanguageClient(
            'Lua',
            'Lua',
            serverOptions,
            clientOptions
        );

        //client.registerProposedFeatures();
        await this.client.start();
        this.onCommand();
        this.statusBar();
    }

    private async getCommand(config: vscode.WorkspaceConfiguration) {
        let executablePath: string = config.get("Lua.misc.executablePath");
        if (executablePath && executablePath != "") {
            return executablePath;
        }
        let command: string;
        let platform: string = os.platform();
        let binDir: string;
        if ((await fs.promises.stat(this.context.asAbsolutePath('server/bin'))).isDirectory()) {
            binDir = 'bin';
        }
        switch (platform) {
            case "win32":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-Windows',
                        'lua-language-server.exe'
                    )
                );
                break;
            case "linux":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-Linux',
                        'lua-language-server'
                    )
                );
                await fs.promises.chmod(command, '777');
                break;
            case "darwin":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-macOS',
                        'lua-language-server'
                    )
                );
                await fs.promises.chmod(command, '777');
                break;
        }
        return command;
    }

    async stop() {
        this.client.stop();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    statusBar() {
        let client = this.client;
        let bar = window.createStatusBarItem();
        bar.text = 'Lua';
        bar.command = 'Lua.statusBar';
        this.disposables.push(Commands.registerCommand(bar.command, () => {
            client.sendNotification('$/status/click');
        }))
        this.disposables.push(client.onNotification('$/status/show', (params) => {
            bar.show();
        }))
        this.disposables.push(client.onNotification('$/status/hide', (params) => {
            bar.hide();
        }))
        this.disposables.push(client.onNotification('$/status/report', (params) => {
            bar.text    = params.text;
            bar.tooltip = params.tooltip;
        }))
        client.sendNotification('$/status/refresh');
        this.disposables.push(bar);
    }

    onCommand() {
        this.disposables.push(this.client.onNotification('$/command', (params) => {
            Commands.executeCommand(params.command, params.data);
        }));
    }
}

export function activate(context: ExtensionContext) {
    registerCustomCommands(context);
    function didOpenTextDocument(document: TextDocument) {
        // We are only interested in language mode text
        if (document.languageId !== 'lua' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
            return;
        }

        // Untitled files go to a default client.
        if (!defaultClient) {
            defaultClient = new LuaClient(context, [
                { language: 'lua' }
            ]);
            defaultClient.start();
            return;
        } else {
            getConfig("Lua.runtime.version", document.uri).then((version) => {
                let x = version;
                setConfig([
                    {
                        action: "set",
                        key:    "Lua.runtime.version",
                        value:  "Lua 5.4",
                        uri:    document.uri,
                    }
                ])
            });
        }
    }

    Workspace.onDidOpenTextDocument(didOpenTextDocument);
    Workspace.textDocuments.forEach(didOpenTextDocument);
}

export async function deactivate() {
    if (defaultClient) {
        defaultClient.stop();
        defaultClient = null;
    }
    return undefined;
}

export async function reportAPIDoc(params: any) {
    if (!defaultClient) {
        return;
    }
    defaultClient.client.sendNotification('$/api/report', params);
}

type ConfigChange = {
    action:  "set",
    key:     string,
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
} | {
    action:  "add",
    key:     string,
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
} | {
    action:  "prop",
    key:     string,
    prop:    string;
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
}

export async function setConfig(changes: ConfigChange[]): Promise<boolean> {
    if (!defaultClient) {
        return false;
    }
    let params = [];
    for (const change of changes) {
        params.push({
            action: change.action,
            prop:   (change.action == "prop") ? change.prop : undefined,
            key:    change.key,
            value:  change.value,
            uri:    change.uri.toString(),
            global: change.global,
        })
    };
    await defaultClient.client.sendRequest(ExecuteCommandRequest.type, {
        command: 'lua.setConfig',
        arguments: params,
    });
    return true;
}

export async function getConfig(key: string, uri: vscode.Uri): Promise<LSPAny> {
    if (!defaultClient) {
        return undefined;
    }
    let result = await defaultClient.client.sendRequest(ExecuteCommandRequest.type, {
        command: 'lua.getConfig',
        arguments: [{
            uri: uri.toString(),
            key: key,
        }]
    });
    return result;
}
