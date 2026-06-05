// vscode extensions use the global `Thenable<T>` alias (PromiseLike).
declare global {
  type Thenable<T> = PromiseLike<T>;
}

export {};
