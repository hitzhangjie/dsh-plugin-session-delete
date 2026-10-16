/**
 * @hitzhangjie/dsh-plugin-session-delete — browser half.
 *
 * Registers one destructive entry in the sidebar session-row "..." menu
 * (`sidebar.workspaces.session.menu.item`, the slot the shipped Pin / Rename /
 * Fork / Archive actions use) and calls the host half's loopback route.
 *
 * The entry is a two-step inline confirmation inside the menu: the first
 * select turns the label into a confirmation, the second performs the delete.
 * The confirmation disarms itself after a few seconds, so a stray click can
 * never delete a session.
 *
 * Bundle format (client-modules protocol): a classic script that registers a
 * factory through `window.__ModuleLoader__.load({ id, factory })`, where the id
 * is exactly the package name. Plain JavaScript, no JSX; `react` and
 * `@deepseek-ai/dsh-client-ui-primitives` are implicit baseline externals for
 * Module Loader packages.
 */
window.__ModuleLoader__.load({
  id: "@hitzhangjie/dsh-plugin-session-delete",
  factory: (require) => {
    const React = require("react");
    const { useCallback, useEffect, useRef, useState } = React;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const MenuItemButton = primitives.MenuItemButton;
    const IconTrashOutlineRegular = primitives.IconTrashOutlineRegular;

    /** Slot id and the host route this entry talks to. */
    const SLOT = "sidebar.workspaces.session.menu.item";
    const ROW_ID = "hitzhangjie-session-delete";
    const ROUTE = "/api/hitzhangjie/session-delete";

    /** How long a disarmed confirmation waits before it resets. */
    const CONFIRM_TIMEOUT_MS = 5000;

    const zh = (navigator.language ?? "").toLowerCase().startsWith("zh");

    const COPY = zh
      ? {
          idle: "删除会话…",
          confirm: () => "确认永久删除?",
          confirmNamed: (title) => `确认永久删除「${title}」?`,
          busy: "删除中…",
          retry: (reason) => `删除失败:${reason}(点击重试)`,
          deferred: "已删除(残留文件将在下次启动时清理)",
          reasons: {
            "invalid-id": "会话 id 无效",
            "not-found": "会话不存在,可能已被删除",
            "has-children": (children) => `该会话有 ${String(children)} 个子会话,请先处理子会话`,
            "list-failed": "无法读取会话列表,已取消",
            forbidden: "请求被拒绝",
            "bad-request": "请求格式不正确",
            "method-not-allowed": "请求方法不被允许",
            "internal-error": "宿主内部错误"
          }
        }
      : {
          idle: "Delete session…",
          confirm: () => "Confirm permanent deletion?",
          confirmNamed: (title) => `Permanently delete “${title}”?`,
          busy: "Deleting…",
          retry: (reason) => `Delete failed: ${reason} (click to retry)`,
          deferred: "Deleted (leftover files are reaped on the next start)",
          reasons: {
            "invalid-id": "invalid session id",
            "not-found": "session not found; it may already be deleted",
            "has-children": (children) => `this session has ${String(children)} child session(s); handle them first`,
            "list-failed": "could not read the session list; deletion cancelled",
            forbidden: "request refused",
            "bad-request": "malformed request",
            "method-not-allowed": "method not allowed",
            "internal-error": "host internal error"
          }
        };

    /**
     * Turn a host refusal into one line of user-facing copy.
     * @param payload - the route's JSON body.
     * @returns localized reason text.
     */
    const reasonText = (payload) => {
      if (payload === null || payload === void 0) return COPY.reasons["internal-error"];
      const entry = COPY.reasons[payload.reason];
      if (typeof entry === "function") {
        const detail = Array.isArray(payload.children) ? payload.children.length : 0;
        return entry(detail > 0 ? detail : "?");
      }
      if (typeof entry === "string") return entry;
      return typeof payload.reason === "string" && payload.reason.length > 0 ? payload.reason : COPY.reasons["internal-error"];
    };

    /** Clip a session title so a menu row stays one line. */
    const clip = (value, limit = 26) => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      if (text.length <= limit) return text;
      return `${text.slice(0, limit - 1)}…`;
    };

    /**
     * The client session service captured by `apply`, used to re-pull the
     * authoritative session list after a committed delete: a cold session is
     * absent from the host's live store, so its removal emits no disposal
     * frame and only a re-pull drops its row.
     */
    let sessionsService = null;

    const refreshSessions = () => {
      const service = sessionsService;
      if (service === null || typeof service.refresh !== "function") return;
      try {
        void Promise.resolve(service.refresh()).catch(() => void 0);
      } catch {
        /* a failed refresh never affects the committed delete */
      }
    };

    /** A hook-shaped fallback, so the component always calls one hook. */
    const fallbackMenuState = () => [true, () => void 0];

    /**
     * One destructive menu row with an in-row two-step confirmation.
     * @param props - slot props: `sessionId`, `displayTitle`, `useMenuOpenState`.
     */
    function DeleteSessionItem(props) {
      const sessionId = props?.sessionId;
      const displayTitle = props?.displayTitle;
      const menuState = (typeof props?.useMenuOpenState === "function" ? props.useMenuOpenState : fallbackMenuState)();
      const setMenuOpen = typeof menuState?.[1] === "function" ? menuState[1] : () => void 0;

      const [step, setStep] = useState("idle");
      const [notice, setNotice] = useState(null);
      const disarm = useRef(null);

      const clearDisarm = useCallback(() => {
        if (disarm.current !== null) {
          clearTimeout(disarm.current);
          disarm.current = null;
        }
      }, []);

      useEffect(() => clearDisarm, [clearDisarm]);

      const arm = useCallback(() => {
        clearDisarm();
        disarm.current = setTimeout(() => {
          disarm.current = null;
          setStep("idle");
        }, CONFIRM_TIMEOUT_MS);
      }, [clearDisarm]);

      const remove = useCallback(() => {
        clearDisarm();
        setStep("busy");
        setNotice(null);
        let pending;
        try {
          pending = fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId })
          });
        } catch (error) {
          setStep("error");
          setNotice(error instanceof Error ? error.message : String(error));
          return;
        }
        Promise.resolve(pending)
          .then(async (response) => {
            let payload = null;
            try {
              payload = await response.json();
            } catch {
              payload = null;
            }
            if (payload === null || payload.ok !== true) {
              setStep("error");
              setNotice(reasonText(payload) ?? `HTTP ${String(response.status)}`);
              return;
            }
            setStep("idle");
            setNotice(payload.deferred === true ? COPY.deferred : null);
            try {
              setMenuOpen(false);
            } catch {
              /* the menu owner decides */
            }
            refreshSessions();
          })
          .catch((error) => {
            setStep("error");
            setNotice(error instanceof Error ? error.message : String(error));
          });
      }, [clearDisarm, sessionId, setMenuOpen]);

      const onSelect = useCallback(() => {
        if (step === "busy") return;
        if (step === "confirm") {
          remove();
          return;
        }
        setStep("confirm");
        setNotice(null);
        arm();
      }, [arm, remove, step]);

      if (typeof sessionId !== "string" || sessionId.length === 0) return null;

      let label;
      if (step === "busy") label = COPY.busy;
      else if (step === "confirm") {
        const title = clip(displayTitle);
        label = title.length > 0 ? COPY.confirmNamed(title) : COPY.confirm();
      } else if (step === "error") label = COPY.retry(notice ?? COPY.reasons["internal-error"]);
      else label = COPY.idle;

      const children = [];
      if (IconTrashOutlineRegular !== void 0) {
        children.push(React.createElement(IconTrashOutlineRegular, { key: "icon", size: 14 }));
      }
      children.push(label);

      const row = React.createElement(
        MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          disabled: step === "busy",
          onSelect,
          title: zh ? "永久删除该会话及其全部记录" : "Permanently delete this session and all of its records"
        },
        children
      );

      if (notice !== null && step !== "error") {
        return React.createElement(
          React.Fragment,
          null,
          row,
          React.createElement(
            "div",
            {
              key: "notice",
              role: "status",
              style: {
                padding: "0 12px 6px",
                fontSize: 12,
                lineHeight: "16px",
                color: "var(--dsw-alias-label-secondary, #8a8a8e)"
              }
            },
            notice
          )
        );
      }
      return row;
    }

    /**
     * @param ctx - the client plugin context.
     */
    const apply = (ctx) => {
      sessionsService = ctx.get("sessions") ?? null;
      if (sessionsService === null) {
        ctx.inject(["sessions"], (scope) => {
          sessionsService = scope.sessions;
        });
      }
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: ROW_ID,
            order: 900
          },
          DeleteSessionItem
        )
      );
    };

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ["slots"] };
  }
});
