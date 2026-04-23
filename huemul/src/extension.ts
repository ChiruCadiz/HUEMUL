import * as vscode from "vscode";
import { HuemulChatProvider } from "./chatProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HuemulChatProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HuemulChatProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("huemul.openChat", async () => {
      await vscode.commands.executeCommand(`${HuemulChatProvider.viewId}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("huemul.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "huemul"
      );
    })
  );
}

export function deactivate(): void {}
