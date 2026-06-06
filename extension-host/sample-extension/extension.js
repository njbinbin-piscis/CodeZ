// A minimal VS Code extension used to smoke-test the AgentZ extension host.
// It uses only the public `vscode` API surface.
const vscode = require("vscode");

function activate(context) {
  let hellos = 0;

  context.subscriptions.push(
    vscode.commands.registerCommand("agentzSample.hello", (name) => {
      hellos++;
      vscode.window.showInformationMessage(`Hello, ${name || "world"}! (#${hellos})`);
      return `hello:${name || "world"}:${hellos}`;
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      "javascript",
      {
        provideCompletionItems(document, position) {
          const item = new vscode.CompletionItem("agentzHello", vscode.CompletionItemKind.Snippet);
          item.insertText = new vscode.SnippetString("agentzHello(${1:arg})");
          item.detail = `from ${document.languageId} @ ${position.line}:${position.character}`;
          item.documentation = new vscode.MarkdownString("**AgentZ** sample completion");
          return [item];
        },
      },
      ".",
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider("javascript", {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position);
        const word = range ? document.getText(range) : "";
        return new vscode.Hover(new vscode.MarkdownString(`AgentZ hover for \`${word}\``));
      },
    }),
  );

  const diagnostics = vscode.languages.createDiagnosticCollection("agentzSample");
  context.subscriptions.push(diagnostics);

  return {
    sampleApi: {
      version: 1,
      ping: () => "pong",
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
