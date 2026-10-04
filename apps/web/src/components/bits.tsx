/** Small shared UI atoms: z-score chips, verdict styling, empty states, comboboxes. */
import { useEffect, useMemo, useRef, useState } from 'react';

const SUBSCRIPT: Record<string, string> = {
  '0': '\u2080', '1': '\u2081', '2': '\u2082', '3': '\u2083', '4': '\u2084',
  '5': '\u2085', '6': '\u2086', '7': '\u2087', '8': '\u2088', '9': '\u2089',
  s: '\u209b', x: '\u2093',
};

/** Westgard rule id -> display form with real subscripts: 1_2s -> 1\u2082\u209b, 10x -> 10\u2093 */
export function prettyRule(rule: string): string {
  if (rule === '7T') return '7T';
  const kx = rule.match(/^(\d+)x$/);
  if (kx) return kx[1] + SUBSCRIPT.x;
  const m = rule.match(/^(.+)_(\d+)s$/);
  if (m) return m[1] + m[2].split('').map((c) => SUBSCRIPT[c] ?? c).join('') + SUBSCRIPT.s;
  return rule;
}

/** Replace rule ids inside a sentence with their subscript display form. */
export function prettyRuleText(text: string): string {
  return text.replace(/\b((?:\d+|R|2of3)_\d+s|\d+x|7T)\b/g, (m) => prettyRule(m));
}

export function zColor(z: number | null): string {
  if (z === null) return 'bg-gray-100 text-gray-500';
  const a = Math.abs(z);
  if (a > 3) return 'bg-red-100 text-red-700';
  if (a > 2) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-700';
}

export function ZChip({ level, z }: { level: string; z: number | null }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 mr-1 ${zColor(z)}`} title={`level ${level}`}>
      <span className="text-[11px] text-gray-500">{level}</span>
      <span className="num text-[12px]">{z === null ? '—' : (z >= 0 ? '+' : '') + z.toFixed(1)}</span>
    </span>
  );
}

export function VerdictWord({ verdict, override }: { verdict: string; override?: string }) {
  const cls =
    verdict === 'pass' ? 'text-green-600' : verdict === 'warning' ? 'text-amber-500' : 'text-red-600';
  return (
    <span className={`font-semibold ${cls}`}>
      {verdict.toUpperCase()}
      {override === 'accepted' && <span className="text-gray-500 font-normal"> · accepted by supervisor</span>}
    </span>
  );
}

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="card p-8 text-center text-gray-500">
      <p>{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="border border-red-200 bg-red-50 text-red-700 rounded px-3 py-2">{String((error as Error)?.message ?? error)}</div>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="microlabel">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/** Keyboard-first combobox: type to filter, ↑/↓ to move, Enter to pick. */
export function Combobox<T extends { id: string }>(props: {
  items: T[];
  value: string | null;
  onChange: (id: string) => void;
  display: (item: T) => string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { items, value, onChange, display, placeholder, autoFocus } = props;
  const selected = items.find((i) => i.id === value) ?? null;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return q ? items.filter((i) => display(i).toLowerCase().includes(q)) : items;
  }, [items, query, display]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <input
        className="w-full"
        placeholder={placeholder ?? 'Select…'}
        autoFocus={autoFocus}
        value={open ? query : selected ? display(selected) : ''}
        onFocus={() => {
          setOpen(true);
          setQuery('');
          setHighlight(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && filtered[highlight]) {
            e.preventDefault();
            onChange(filtered[highlight].id);
            setOpen(false);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full card max-h-56 overflow-auto shadow-sm">
          {filtered.map((item, i) => (
            <li
              key={item.id}
              className={`px-2 py-1 cursor-pointer ${i === highlight ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50'}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(item.id);
                setOpen(false);
              }}
            >
              {display(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div className="inline-flex gap-0.5 bg-slate-100 rounded-lg p-0.5">
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 py-1 rounded-md font-medium tracking-[-0.01em] ${
            t === active
              ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function Collapsed({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button
        className="w-full text-left px-4 py-2.5 text-slate-500 hover:text-slate-900 font-medium tracking-[-0.01em] rounded-xl"
        onClick={() => setOpen(!open)}
      >
        <span className="inline-block w-4 text-slate-300">{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="px-4 pb-4 text-slate-600">{children}</div>}
    </div>
  );
}
