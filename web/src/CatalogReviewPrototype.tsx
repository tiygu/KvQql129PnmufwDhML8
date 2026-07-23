import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, ImageOff, Pencil, SkipForward, Sparkles } from "lucide-react";
import "./catalog-review-prototype.css";
import "./catalog-review-planning-prototype.css";

// PROTOTYPE — three item-identity review structures, switchable via ?variant=, on /prototype/catalog-review.
type Variant = "A" | "B" | "C";
type Item = {
  id: string;
  name: string;
  level: number;
  type: string;
  icon: string | null;
  reason: string | null;
  chain: { name: string; current: number; items: string[] };
  blocker: { order: string; summary: string; missing: string[] };
  names: { value: string; source: string; count: number; selected?: boolean }[];
  history: string[];
};

const initialItems: Item[] = [
  { id: "10100042", name: "精致的茶点篮", level: 5, type: "茶点", icon: "🧺", reason: "名称与合成关系待确认", chain: { name: "英式茶点", current: 4, items: ["茶叶", "茶杯", "茶壶", "点心盘", "精致的茶点篮", "? 未知物品", "茶会推车", "花园茶亭", "皇家茶宴"] }, blocker: { order: "订单 2：花园茶会", summary: "无法生成合成步骤", missing: ["当前物品名称存在冲突", "L5 → L6 合成关系尚未生效"] }, names: [{ value: "精致的茶点篮", source: "运行时配置", count: 12, selected: true }, { value: "豪华下午茶篮", source: "真实动作观测", count: 3 }], history: ["运行时配置连续观测 12 次", "合成后出现“豪华下午茶篮”3 次"] },
  { id: "10100057", name: "未命名物品", level: 2, type: "未知类型", icon: "🪷", reason: "未知名称", chain: { name: "池塘花卉", current: 1, items: ["花苞", "未命名物品", "睡莲", "荷花", "池塘花束", "水上花园", "莲花喷泉"] }, blocker: { order: "订单 1：池塘装饰", summary: "目标物品身份未知，无法匹配订单需求", missing: ["物品名称"] }, names: [{ value: "未命名物品", source: "当前候选", count: 1, selected: true }], history: ["棋盘格 38 出现 1 次", "同链上一级：花苞"] },
  { id: "10100063", name: "周年庆典特别限定超豪华草莓奶油夹心蛋糕礼盒", level: 8, type: "甜点", icon: "🎂", reason: "新观测", chain: { name: "庆典甜点", current: 7, items: ["奶油", "纸杯蛋糕", "草莓塔", "水果蛋糕", "双层蛋糕", "庆典蛋糕", "草莓奶油蛋糕", "周年庆典特别限定超豪华草莓奶油夹心蛋糕礼盒"] }, blocker: { order: "订单 3：周年庆典", summary: "新物品尚未确认，保守规划暂停", missing: ["物品身份确认"] }, names: [{ value: "周年庆典特别限定超豪华草莓奶油夹心蛋糕礼盒", source: "运行时配置", count: 8, selected: true }], history: ["运行时配置连续观测 8 次"] },
  { id: "10100071", name: "园艺手套", level: 3, type: "工具", icon: null, reason: "新观测", chain: { name: "园艺工具", current: 2, items: ["种子铲", "小铲子", "园艺手套", "修枝剪", "园艺箱", "专业工具车"] }, blocker: { order: "无受阻订单", summary: "图标缺失不阻塞合成规划", missing: [] }, names: [{ value: "园艺手套", source: "运行时配置", count: 5, selected: true }], history: ["名称与等级一致；图标仍待补采"] },
  { id: "10100088", name: "蜂蜜罐", level: 4, type: "食材", icon: "🍯", reason: null, chain: { name: "蜂蜜制品", current: 3, items: ["蜂巢", "蜂蜜滴", "蜂蜜勺", "蜂蜜罐", "蜂蜜礼盒", "蜂蜜甜点塔", "皇家蜂蜜宴"] }, blocker: { order: "无受阻订单", summary: "所有合成知识已生效", missing: [] }, names: [{ value: "蜂蜜罐", source: "运行时配置", count: 14, selected: true }], history: ["所有证据一致，可快速确认"] },
];

const variants: { key: Variant; name: string }[] = [
  { key: "A", name: "队列 + 结论面板" },
  { key: "B", name: "逐项专注向导" },
  { key: "C", name: "表格快速审核" },
];

function itemIcon(item: Item) {
  return <div className={`crp-icon ${item.icon ? "" : "missing"}`}>{item.icon || <ImageOff size={28}/>}</div>;
}

function ConflictChoices({ item, selectedName, setSelectedName }: { item: Item; selectedName: string; setSelectedName: (value: string) => void }) {
  if (item.names.length < 2) return null;
  return <section className="crp-conflict">
    <div className="crp-section-title"><AlertTriangle size={17}/><div><strong>需要你选择名称</strong><span>两份可靠证据不一致</span></div></div>
    <div className="crp-choices">{item.names.map((choice) => <button key={choice.value} className={selectedName === choice.value ? "selected" : ""} onClick={() => setSelectedName(choice.value)}>
      <i>{selectedName === choice.value && <Check size={14}/>}</i><span><strong>{choice.value}</strong><small>{choice.source} · 出现 {choice.count} 次</small></span>
    </button>)}</div>
  </section>;
}

function ItemFacts({ item, draftName, editing, setEditing, setDraftName }: { item: Item; draftName: string; editing: boolean; setEditing: (value: boolean) => void; setDraftName: (value: string) => void }) {
  return <section className="crp-facts">
    <div><span>名称</span>{editing ? <input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)}/> : <strong title={draftName}>{draftName}</strong>}</div>
    <div><span>等级</span><strong>L{item.level}</strong></div>
    <div><span>类型</span><strong>{item.type}</strong></div>
    <button onClick={() => setEditing(!editing)}><Pencil size={14}/>{editing ? "完成修改" : "修改资料"}</button>
  </section>;
}

function PlanningContext({ item, onFocusName }: { item: Item; onFocusName: () => void }) {
  const chainRef = useRef<HTMLDivElement>(null);
  const [focusedChainIndex, setFocusedChainIndex] = useState(item.chain.current);
  useEffect(() => setFocusedChainIndex(item.chain.current), [item.id]);
  const focusedName = item.chain.items[focusedChainIndex];
  const focusedUnknown = focusedName.startsWith("? ");
  const focusBlocker = (reason: string) => {
    if (reason.includes("名称")) {
      onFocusName();
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".crp-facts input")?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    const unknownIndex = item.chain.items.findIndex((name) => name.startsWith("? "));
    if (unknownIndex >= 0) {
      setFocusedChainIndex(unknownIndex);
      requestAnimationFrame(() => chainRef.current?.children[unknownIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }));
    }
  };
  return <section className="crp-planning">
    <article><span>1 · 物品名称</span><strong title={item.name}>{item.name}</strong><small>{item.reason || "名称证据一致"}</small></article>
    <article className={item.blocker.missing.length ? "blocked" : "clear"}><span>3 · 订单为什么卡住</span><strong>{item.blocker.order}</strong><small>{item.blocker.summary}</small>{item.blocker.missing.map((reason) => <button className="crp-blocker-link" key={reason} onClick={() => focusBlocker(reason)}>{reason}<ChevronRight size={13}/></button>)}</article>
    <article className="crp-chain-card"><span>2 · 完整合成链</span><div className="crp-chain-title"><strong>{item.chain.name}</strong><small>正在查看 L{focusedChainIndex + 1} / L{item.chain.items.length}</small></div><div className="crp-chain-controls"><button onClick={() => chainRef.current?.scrollBy({ left: -320, behavior: "smooth" })}><ArrowLeft size={17}/></button><div ref={chainRef} className="crp-chain-track">{item.chain.items.map((name, chainIndex) => { const unknown = name.startsWith("? "); return <div className={`${chainIndex === focusedChainIndex ? "current" : ""} ${unknown ? "unknown" : ""}`} key={`${name}-${chainIndex}`} onClick={() => setFocusedChainIndex(chainIndex)}><i>{unknown ? "?" : chainIndex === item.chain.current ? item.icon || "?" : chainIndex + 1}</i><strong title={name}>{unknown ? "未知物品" : name}</strong><small>L{chainIndex + 1}{unknown ? " · 链条断点" : ""}</small>{chainIndex < item.chain.items.length - 1 && <b>×2 →</b>}</div>; })}</div><button onClick={() => chainRef.current?.scrollBy({ left: 320, behavior: "smooth" })}><ArrowRight size={17}/></button></div>
      <div className={`crp-chain-focus ${focusedUnknown ? "unknown" : ""}`}><div className="crp-chain-focus-icon">{focusedUnknown ? <ImageOff size={24}/> : focusedChainIndex === item.chain.current ? item.icon : focusedChainIndex + 1}</div><div><span>当前审核焦点 · L{focusedChainIndex + 1}</span><strong>{focusedUnknown ? "未知物品" : focusedName}</strong><small>{focusedUnknown ? "已有线索：由当前 L5 物品合成后出现；图标尚未采集；名称证据尚未形成一致候选。" : focusedChainIndex === item.chain.current ? "当前队列物品；可在下方修改资料并保存。" : "该节点已有生效身份；点击可快速核对。"}</small></div>{focusedUnknown && <button>查看 2 条观测证据</button>}</div>
    </article>
  </section>;
}

function Evidence({ item, open, setOpen }: { item: Item; open: boolean; setOpen: (value: boolean) => void }) {
  return <section className="crp-evidence">
    <button onClick={() => setOpen(!open)}>{open ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}查看依据与技术详情 <small>内部 ID {item.id}</small></button>
    {open && <ul>{item.history.map((line) => <li key={line}>{line}</li>)}<li>完整原始数据仅在这里按需查看</li></ul>}
  </section>;
}

function Actions({ changed, onConfirm, onSkip }: { changed: boolean; onConfirm: () => void; onSkip: () => void }) {
  return <div className="crp-actions"><button className="skip" onClick={onSkip}><SkipForward size={17}/>暂时跳过</button><button className="confirm" onClick={onConfirm}><Check size={18}/>{changed ? "修改后确认" : "确认无误"}</button></div>;
}

function VariantA({ items, index, choose, selectedName, setSelectedName, draftName, setDraftName, editing, setEditing, evidenceOpen, setEvidenceOpen, confirm, skip }: any) {
  const item = items[index];
  const [queueMode, setQueueMode] = useState<"blocking" | "later">("blocking");
  const queueEntries = items.map((entry: Item, itemIndex: number) => ({ entry, itemIndex })).filter(({ entry }: { entry: Item }) => queueMode === "blocking" ? entry.blocker.missing.length > 0 : entry.blocker.missing.length === 0);
  const switchQueue = (mode: "blocking" | "later") => {
    setQueueMode(mode);
    const firstIndex = items.findIndex((entry: Item) => mode === "blocking" ? entry.blocker.missing.length > 0 : entry.blocker.missing.length === 0);
    if (firstIndex >= 0) choose(firstIndex);
  };
  return <div className="crp-layout-a">
    <aside className="crp-queue"><h2>规划诊断 <b>{items.filter((entry: Item) => entry.blocker.missing.length > 0).length}</b></h2><div className="crp-queue-tabs"><button className={queueMode === "blocking" ? "active" : ""} onClick={() => switchQueue("blocking")}>阻塞中</button><button className={queueMode === "later" ? "active" : ""} onClick={() => switchQueue("later")}>以后再看</button></div><p>{queueMode === "blocking" ? "只显示正在妨碍订单继续的对象" : "不影响当前规划的完整性与复核工作"}</p>{queueEntries.map(({ entry, itemIndex }: { entry: Item; itemIndex: number }) => <button key={entry.id} className={index === itemIndex ? "active" : ""} onClick={() => choose(itemIndex)}>{itemIcon(entry)}<span><strong title={entry.name}>{entry.name}</strong><small>L{entry.level} · {queueMode === "blocking" ? entry.blocker.order : entry.reason || "证据一致"}</small></span>{entry.reason && <i/>}</button>)}</aside>
    <main className="crp-detail"><header><div>{itemIcon(item)}<span><small>合成阻塞诊断 · {index + 1}/{items.length}</small><h1 title={draftName}>{draftName}</h1><p>{item.blocker.missing.length ? `${item.blocker.missing.length} 项知识阻止订单继续` : "当前物品没有阻塞订单"}</p></span></div></header><PlanningContext item={item} onFocusName={() => setEditing(true)}/><ConflictChoices item={item} selectedName={selectedName} setSelectedName={setSelectedName}/><ItemFacts item={item} draftName={draftName} editing={editing} setEditing={setEditing} setDraftName={setDraftName}/><Evidence item={item} open={evidenceOpen} setOpen={setEvidenceOpen}/><Actions changed={draftName !== item.name || selectedName !== item.names.find((x) => x.selected)?.value} onConfirm={confirm} onSkip={skip}/></main>
  </div>;
}

function VariantB({ items, index, selectedName, setSelectedName, draftName, setDraftName, editing, setEditing, evidenceOpen, setEvidenceOpen, confirm, skip }: any) {
  const item = items[index];
  return <main className="crp-focus"><div className="crp-progress"><span style={{ width: `${((index + 1) / items.length) * 100}%` }}/></div><p className="crp-step">审核物品 {index + 1} / {items.length}</p><div className="crp-focus-hero">{itemIcon(item)}<div><h1 title={draftName}>{draftName}</h1><p>{item.reason ? <><AlertTriangle size={15}/>{item.reason}</> : <><Check size={15}/>没有冲突</>}</p></div></div><div className="crp-focus-card"><ConflictChoices item={item} selectedName={selectedName} setSelectedName={setSelectedName}/><ItemFacts item={item} draftName={draftName} editing={editing} setEditing={setEditing} setDraftName={setDraftName}/><Evidence item={item} open={evidenceOpen} setOpen={setEvidenceOpen}/></div><Actions changed={draftName !== item.name || selectedName !== item.names.find((x) => x.selected)?.value} onConfirm={confirm} onSkip={skip}/><p className="crp-next-note">确认或跳过后自动进入下一项</p></main>;
}

function VariantC({ items, index, choose, confirm, skip, selectedName, setSelectedName, draftName, setDraftName, editing, setEditing, evidenceOpen, setEvidenceOpen }: any) {
  const item = items[index];
  return <div className="crp-table-shell"><header><div><h1>物品身份审核</h1><p>适合连续处理证据一致的条目</p></div><strong>{index + 1} / {items.length}</strong></header><div className="crp-table"><div className="head"><span>物品</span><span>名称</span><span>等级 / 类型</span><span>状态</span><span>动作</span></div>{items.map((entry: Item, itemIndex: number) => <div className={index === itemIndex ? "active" : ""} key={entry.id} onClick={() => choose(itemIndex)}>{itemIcon(entry)}<strong title={entry.name}>{entry.name}</strong><span>L{entry.level} · {entry.type}</span><em className={entry.reason ? "warn" : "ok"}>{entry.reason || "可快速确认"}</em><button onClick={(event) => { event.stopPropagation(); choose(itemIndex); entry.reason ? undefined : confirm(itemIndex); }}>{entry.reason ? "打开" : "确认无误"}</button></div>)}</div><aside className="crp-drawer"><button className="crp-drawer-close" onClick={skip}>×</button><div className="crp-drawer-title">{itemIcon(item)}<div><small>当前审核</small><h2 title={draftName}>{draftName}</h2></div></div><ConflictChoices item={item} selectedName={selectedName} setSelectedName={setSelectedName}/><ItemFacts item={item} draftName={draftName} editing={editing} setEditing={setEditing} setDraftName={setDraftName}/><Evidence item={item} open={evidenceOpen} setOpen={setEvidenceOpen}/><Actions changed={draftName !== item.name || selectedName !== item.names.find((x) => x.selected)?.value} onConfirm={confirm} onSkip={skip}/></aside></div>;
}

export default function CatalogReviewPrototype() {
  const requested = new URLSearchParams(location.search).get("variant")?.toUpperCase();
  const variant = (variants.some((entry) => entry.key === requested) ? requested : "A") as Variant;
  const [items, setItems] = useState(initialItems);
  const [index, setIndex] = useState(0);
  const [selectedName, setSelectedName] = useState(items[0].names[0].value);
  const [draftName, setDraftName] = useState(items[0].name);
  const [editing, setEditing] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [toast, setToast] = useState("");
  const currentVariant = variants.find((entry) => entry.key === variant)!;

  const choose = (nextIndex: number) => {
    const next = items[nextIndex];
    setIndex(nextIndex); setSelectedName(next.names.find((x) => x.selected)?.value || next.names[0].value); setDraftName(next.name); setEditing(false); setEvidenceOpen(false);
  };
  const advance = (message: string, forcedIndex?: number) => {
    const reviewedIndex = forcedIndex ?? index;
    setToast(`${items[reviewedIndex].name}：${message}，已进入下一项`);
    choose((reviewedIndex + 1) % items.length);
  };
  const confirm = (forcedIndex?: number) => {
    const reviewedIndex = forcedIndex ?? index;
    const reviewed = items[reviewedIndex];
    if (!reviewed.blocker.missing.length) {
      advance(draftName !== reviewed.name || selectedName !== reviewed.names.find((x) => x.selected)?.value ? "修改后确认" : "确认无误", reviewedIndex);
      return;
    }
    const remaining = reviewed.blocker.missing.slice(1);
    setItems((current) => current.map((entry, itemIndex) => itemIndex === reviewedIndex ? { ...entry, blocker: { ...entry.blocker, missing: remaining, summary: remaining.length ? "重新规划后仍无法生成合成步骤" : "重新规划成功，订单可以继续" } } : entry));
    if (remaining.length) {
      setToast(`已保存并重新规划；仍然卡住：${remaining.join("、")}`);
      return;
    }
    setToast(`已保存并重新规划；${reviewed.blocker.order} 已恢复`);
    const nextBlockingIndex = items.findIndex((entry, itemIndex) => itemIndex !== reviewedIndex && entry.blocker.missing.length > 0);
    choose(nextBlockingIndex >= 0 ? nextBlockingIndex : reviewedIndex);
  };
  const props = { items, index, choose, selectedName, setSelectedName, draftName, setDraftName, editing, setEditing, evidenceOpen, setEvidenceOpen, confirm, skip: () => advance("暂时跳过") };
  const nextVariant = (delta: number) => {
    const next = variants[(variants.findIndex((entry) => entry.key === variant) + delta + variants.length) % variants.length];
    const params = new URLSearchParams(location.search); params.set("variant", next.key); history.replaceState(null, "", `${location.pathname}?${params}`); location.reload();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName) || (event.target as HTMLElement)?.isContentEditable) return;
      if (event.key === "ArrowLeft") nextVariant(-1);
      if (event.key === "ArrowRight") nextVariant(1);
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  }, [variant]);
  const screen = useMemo(() => variant === "A" ? <VariantA {...props}/> : variant === "B" ? <VariantB {...props}/> : <VariantC {...props}/>, [variant, index, selectedName, draftName, editing, evidenceOpen]);
  return <div className={`crp-root variant-${variant.toLowerCase()}`}><div className="crp-banner"><Sparkles size={15}/><strong>抛弃式原型</strong><span>所有操作只保存在内存中，刷新即可重置</span></div>{toast && <button className="crp-toast" onClick={() => setToast("")}>{toast} ×</button>}{screen}<div className="crp-switcher"><button onClick={() => nextVariant(-1)} aria-label="上一个方案"><ArrowLeft/></button><span><b>{variant}</b> — {currentVariant.name}</span><button onClick={() => nextVariant(1)} aria-label="下一个方案"><ArrowRight/></button></div></div>;
}
