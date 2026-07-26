export type CatalogMutationAvailability = {
  available: boolean;
  reason: string | null;
};

export type CatalogWorkspaceCommand = {
  availability: CatalogMutationAvailability;
  execute: () => void | Promise<void>;
};

type CommandOptions = {
  available?: boolean;
  reason?: string;
};

type CatalogWorkspaceCommandsOptions = {
  busy: boolean;
  semanticSnapshotCurrent: boolean;
  onUnavailable: (reason: string) => void;
};

export class CatalogWorkspaceCommands {
  constructor(private readonly options: CatalogWorkspaceCommandsOptions) {}

  semantic(execute: CatalogWorkspaceCommand["execute"], options?: CommandOptions) {
    return this.create("semantic", execute, options);
  }

  reviewSession(execute: CatalogWorkspaceCommand["execute"], options?: CommandOptions) {
    return this.create("semantic", execute, options);
  }

  evidence(execute: CatalogWorkspaceCommand["execute"], options?: CommandOptions) {
    return this.create("semantic", execute, options);
  }

  object(execute: CatalogWorkspaceCommand["execute"], options?: CommandOptions) {
    return this.create("semantic", execute, options);
  }

  displayIcon(execute: CatalogWorkspaceCommand["execute"], options?: CommandOptions) {
    return this.create("display-icon", execute, options);
  }

  private create(
    capability: "semantic" | "display-icon",
    execute: CatalogWorkspaceCommand["execute"],
    options: CommandOptions = {},
  ): CatalogWorkspaceCommand {
    const semanticAvailable = capability === "display-icon" || this.options.semanticSnapshotCurrent;
    const available = !this.options.busy && semanticAvailable && options.available !== false;
    const reason = this.options.busy
      ? "工作台正在处理上一项操作。"
      : !semanticAvailable
        ? "审核结论已经保存；请先重试刷新工作台，再执行依赖当前语义对象的变更操作。"
        : options.available === false ? options.reason || "当前条件不允许执行该操作。" : null;
    return {
      availability: { available, reason },
      execute: () => {
        if (!available) {
          if (reason) this.options.onUnavailable(reason);
          return;
        }
        return execute();
      },
    };
  }
}
