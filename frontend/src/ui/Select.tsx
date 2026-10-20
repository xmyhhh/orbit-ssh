import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string;
};

export type SelectGroup = {
  label: string;
  options: SelectOption[];
};

export type SelectSize = "sm" | "md" | "lg";

const POPUP_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MIN_POPUP_HEIGHT = 120;
const MAX_POPUP_HEIGHT = 320;

type Row =
  | { kind: "group"; label: string }
  | { kind: "option"; option: SelectOption; index: number };

export function Select({
  value,
  onChange,
  options,
  groups,
  ariaLabel,
  size = "md",
  className = "",
  disabled = false,
  placeholder = "请选择",
  creatable = false,
  createLabel = "创建",
}: {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  ariaLabel: string;
  size?: SelectSize;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  creatable?: boolean;
  createLabel?: string;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    dropUp: boolean;
  } | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    let index = 0;
    if (groups) {
      for (const group of groups) {
        result.push({ kind: "group", label: group.label });
        for (const option of group.options)
          result.push({ kind: "option", option, index: index++ });
      }
    } else {
      for (const option of options ?? [])
        result.push({ kind: "option", option, index: index++ });
    }
    return result;
  }, [groups, options]);

  const items = useMemo(
    () =>
      rows.filter(
        (row): row is Extract<Row, { kind: "option" }> => row.kind === "option",
      ),
    [rows],
  );

  const normalized = query.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    if (!normalized) return rows;
    return rows.filter(
      (row) =>
        row.kind === "group" ||
        row.option.label.toLowerCase().includes(normalized) ||
        row.option.value.toLowerCase().includes(normalized),
    );
  }, [rows, normalized]);

  const visibleItems = useMemo(
    () =>
      visibleRows.filter(
        (row): row is Extract<Row, { kind: "option" }> => row.kind === "option",
      ),
    [visibleRows],
  );

  const exactMatch = items.some(
    (item) =>
      item.option.value === query.trim() ||
      item.option.label.toLowerCase() === normalized,
  );
  const canCreate = creatable && query.trim().length > 0 && !exactMatch;

  const selected = items.find((item) => item.option.value === value);
  const selectedLabel = selected
    ? selected.option.label
    : creatable && value
      ? value
      : placeholder;
  const isPlaceholder = !selected && !(creatable && value);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setQuery("");
  }, []);

  const commit = useCallback(
    (option: SelectOption) => {
      if (option.disabled) return;
      onChange(option.value);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange],
  );

  const openList = useCallback(() => {
    setOpen(true);
    setQuery("");
    const current = items.find((item) => item.option.value === value);
    setActiveIndex(current ? current.index : 0);
  }, [items, value]);

  const commitActive = useCallback(() => {
    if (canCreate) {
      onChange(query.trim());
      close();
      triggerRef.current?.focus();
      return;
    }
    const item =
      items.find((entry) => entry.index === activeIndex) ??
      visibleItems.find((entry) => !entry.option.disabled);
    if (item) commit(item.option);
  }, [
    activeIndex,
    canCreate,
    close,
    commit,
    items,
    onChange,
    query,
    visibleItems,
  ]);

  const move = useCallback(
    (step: number) => {
      if (!visibleItems.length) return;
      const enabled = visibleItems.filter((item) => !item.option.disabled);
      if (!enabled.length) return;
      const current = visibleItems.findIndex(
        (item) => item.index === activeIndex,
      );
      const nextIndex =
        current < 0
          ? enabled[0].index
          : (() => {
              const position = enabled.findIndex(
                (item) => item.index === current,
              );
              const target = position + step;
              if (target < 0) return enabled[enabled.length - 1].index;
              if (target >= enabled.length) return enabled[0].index;
              return enabled[target].index;
            })();
      setActiveIndex(nextIndex);
    },
    [activeIndex, visibleItems],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const box = trigger.getBoundingClientRect();
      const height = popupRef.current?.scrollHeight ?? 0;
      const below =
        window.innerHeight - box.bottom - POPUP_GAP - VIEWPORT_MARGIN;
      const above = box.top - POPUP_GAP - VIEWPORT_MARGIN;
      const dropUp = height > below && above > below;
      const available = dropUp ? above : below;
      const maxHeight = Math.max(
        MIN_POPUP_HEIGHT,
        Math.min(MAX_POPUP_HEIGHT, available),
      );
      let left = box.left;
      if (left + box.width > window.innerWidth - VIEWPORT_MARGIN)
        left = Math.max(
          VIEWPORT_MARGIN,
          window.innerWidth - box.width - VIEWPORT_MARGIN,
        );
      setPosition({
        top: dropUp ? box.top - POPUP_GAP : box.bottom + POPUP_GAP,
        left,
        width: box.width,
        maxHeight,
        dropUp,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, visibleRows.length, query]);

  useEffect(() => {
    if (!open) return;
    document.body.dataset.selectOpen = "true";
    return () => {
      delete document.body.dataset.selectOpen;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      )
        return;
      // A click on the dialog backdrop should only dismiss the dropdown.
      if ((target as Element).classList?.contains("modal-scrim"))
        event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    if (creatable) searchRef.current?.focus();
  }, [creatable, open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openList();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(visibleItems[0]?.index ?? -1);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(
          visibleItems.filter((item) => !item.option.disabled).at(-1)?.index ??
            -1,
        );
        break;
      case "Enter":
        event.preventDefault();
        commitActive();
        break;
      case " ":
        event.preventDefault();
        if (creatable) return;
        commitActive();
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
        break;
      case "Tab":
        close();
        break;
      default:
        if (creatable || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.length !== 1) return;
        event.preventDefault();
        const now = Date.now();
        const buffer =
          now - typeahead.current.at > 700
            ? event.key
            : typeahead.current.text + event.key;
        typeahead.current = { text: buffer, at: now };
        const match = visibleItems.find((item) =>
          item.option.label.toLowerCase().startsWith(buffer.toLowerCase()),
        );
        if (match) setActiveIndex(match.index);
        break;
    }
  }

  function optionId(index: number) {
    return `${listId}-option-${index}`;
  }

  const popup = open && position && (
    <div
      ref={popupRef}
      id={listId}
      role="listbox"
      aria-label={ariaLabel}
      className={`select-popup ${position.dropUp ? "drop-up" : ""}`}
      style={{
        top: position.top,
        left: position.left,
        minWidth: position.width,
        maxHeight: position.maxHeight,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {creatable && (
        <div className="select-search">
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索或新建…"
            aria-label={`${ariaLabel}搜索`}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                commitActive();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                triggerRef.current?.focus();
              } else if (event.key === "Tab") {
                event.preventDefault();
                close();
                triggerRef.current?.focus();
              }
            }}
          />
        </div>
      )}
      {visibleRows.map((row) =>
        row.kind === "group" ? (
          <p className="select-group-label" key={`group-${row.label}`}>
            {row.label}
          </p>
        ) : (
          <button
            type="button"
            role="option"
            id={optionId(row.index)}
            key={row.option.value}
            aria-selected={row.option.value === value}
            disabled={row.option.disabled}
            className={`select-option ${
              row.index === activeIndex ? "is-active" : ""
            }`}
            onMouseEnter={() => setActiveIndex(row.index)}
            onClick={() => commit(row.option)}
          >
            <span className="select-option-label">{row.option.label}</span>
            {row.option.hint && (
              <span className="select-option-hint">{row.option.hint}</span>
            )}
            {row.option.value === value && (
              <Check size={14} className="select-check" aria-hidden="true" />
            )}
          </button>
        ),
      )}
      {canCreate && (
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="select-option select-create"
          onClick={() => {
            onChange(query.trim());
            close();
            triggerRef.current?.focus();
          }}
        >
          <Plus size={14} aria-hidden="true" />
          <span className="select-option-label">
            {createLabel}「{query.trim()}」
          </span>
        </button>
      )}
      {!visibleRows.length && !canCreate && (
        <p className="select-empty">没有匹配的选项</p>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        aria-label={ariaLabel}
        disabled={disabled}
        className={`select-trigger select-trigger--${size} ${
          isPlaceholder ? "is-placeholder" : ""
        } ${className}`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={handleKeyDown}
      >
        <span className="select-value">{selectedLabel}</span>
        <ChevronDown size={15} className="select-chevron" aria-hidden="true" />
      </button>
      {popup && createPortal(popup, document.body)}
    </>
  );
}
