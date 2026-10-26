import { useId, useMemo, useState } from 'react';
import type { Order } from '../types';
import './Charts.css';

const DAY = 86_400_000;
const money = (amount: number) => new Intl.NumberFormat('en-DZ', { maximumFractionDigits: 0 }).format(amount);
const shortDate = (date: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
const isRevenue = (order: Order) => order.status !== 'cancelled' && order.status !== 'returned';

function curve(points: [number, number][]) {
  return points.map(([x, y], index) => {
    if (!index) return `M ${x},${y}`;
    const [previousX, previousY] = points[index - 1];
    const middle = (previousX + x) / 2;
    return `C ${middle},${previousY} ${middle},${y} ${x},${y}`;
  }).join(' ');
}

export function RevenueChart({ orders, days }: { orders: Order[]; days: number }) {
  const gradientId = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const data = useMemo(() => {
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = today - (days - 1) * DAY;
    const current = Array.from({ length: days }, (_, index) => ({ date: start + index * DAY, amount: 0, previous: 0 }));
    orders.filter(isRevenue).forEach(order => {
      const index = Math.floor((new Date(order.createdAt).getTime() - start) / DAY);
      if (index >= 0 && index < days) current[index].amount += order.amount;
      else if (index >= -days && index < 0) current[index + days].previous += order.amount;
    });
    return current;
  }, [orders, days]);
  const maxAmount = Math.max(...data.flatMap(point => [point.amount, point.previous]), 1);
  const unit = maxAmount > 10000 ? 10000 : maxAmount > 1000 ? 1000 : 100;
  const ceiling = Math.ceil(maxAmount / (4 * unit)) * (4 * unit);
  const x = (index: number) => 55 + index / Math.max(days - 1, 1) * 620;
  const y = (amount: number) => 196 - (amount / ceiling) * 166;
  const points = data.map((point, index) => [x(index), y(point.amount)] as [number, number]);
  const priorPoints = data.map((point, index) => [x(index), y(point.previous)] as [number, number]);
  const labelIndices = Array.from(new Set(Array.from({ length: Math.min(days, 7) }, (_, index) => Math.round(index * (days - 1) / (Math.min(days, 7) - 1)))));
  const selected = active === null ? null : data[Math.min(active, data.length - 1)];
  const tooltipX = active === null ? 0 : Math.max(56, Math.min(x(active) - 80, 510));

  if (!orders.length) return <div className="chart-empty"><span className="chart-empty-symbol">↗</span><strong>Your next chapter starts here</strong><span>Create an order to start seeing your revenue.</span></div>;

  return <div className="revenue-chart">
    <svg viewBox="0 0 700 240" role="img" aria-label={`Daily order revenue in DZD for the last ${days} days. Use left and right arrow keys to explore.`} tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          setActive(previous => Math.max(0, Math.min(days - 1, (previous ?? 0) + (event.key === 'ArrowRight' ? 1 : -1))));
        }
        if (event.key === 'Escape') setActive(null);
      }}
      onMouseMove={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const mouseX = (event.clientX - bounds.left) / bounds.width * 700;
        setActive(Math.max(0, Math.min(days - 1, Math.round((mouseX - 55) / 620 * (days - 1)))));
      }} onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)}>
      <title>Order revenue, current and previous {days}-day periods</title>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b7a55" stopOpacity=".18"/><stop offset="100%" stopColor="#3b7a55" stopOpacity=".015"/></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(index => {
        const value = ceiling * index / 4;
        return <g key={index}><line x1="55" y1={y(value)} x2="675" y2={y(value)} stroke="#edf0ed" strokeDasharray={index ? '4 4' : undefined}/><text x="42" y={y(value) + 4} textAnchor="end" className="chart-axis">{value >= 1000 ? `${Math.round(value / 1000)}k` : value}</text></g>;
      })}
      <path d={`${curve(points)} L 675,196 L 55,196 Z`} fill={`url(#${gradientId})`}/>
      <path d={curve(priorPoints)} fill="none" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="5 5"/>
      <path d={curve(points)} fill="none" stroke="#367650" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
      {labelIndices.map(index => <text key={index} x={x(index)} y="225" textAnchor="middle" className="chart-axis">{shortDate(data[index].date)}</text>)}
      {selected && active !== null && <g aria-hidden="true">
        <line x1={x(active)} x2={x(active)} y1="28" y2="196" stroke="#7c9f85" strokeDasharray="3 4"/>
        <circle cx={x(active)} cy={y(selected.amount)} r="5" fill="#367650" stroke="white" strokeWidth="2.5"/>
        <rect x={tooltipX} y="3" width="164" height="53" rx="8" fill="#173f30"/>
        <text x={tooltipX + 12} y="23" fill="#c9dacd" fontSize="10">{shortDate(selected.date)}</text>
        <text x={tooltipX + 12} y="43" fill="white" fontSize="13" fontWeight="600">{money(selected.amount)} DZD</text>
      </g>}
    </svg>
    <span className="chart-sr" aria-live="polite">{selected ? `${shortDate(selected.date)}: ${money(selected.amount)} DZD in order revenue. Previous period: ${money(selected.previous)} DZD.` : ''}</span>
  </div>;
}

export function OrderDonut({ orders }: { orders: Order[] }) {
  const segments = [
    { label: 'Delivered', color: '#285d43', value: orders.filter(order => order.status === 'delivered').length },
    { label: 'In progress', color: '#b2ce85', value: orders.filter(order => order.status === 'confirmed' || order.status === 'shipped').length },
    { label: 'Pending', color: '#edb778', value: orders.filter(order => order.status === 'pending').length },
    { label: 'Cancelled / returned', color: '#e3e7e2', value: orders.filter(order => order.status === 'cancelled' || order.status === 'returned').length },
  ];
  const circumference = 2 * Math.PI * 55;
  let offset = 0;
  return <div className="order-donut">
    <svg viewBox="0 0 144 144" className="donut-svg" role="img" aria-label={`Order breakdown: ${segments.map(segment => `${segment.value} ${segment.label.toLowerCase()}`).join(', ')}`}>
      <circle cx="72" cy="72" r="55" fill="none" stroke="#f0f2ed" strokeWidth="17"/>
      {segments.map(segment => {
        const length = orders.length ? segment.value / orders.length * circumference : 0;
        const circle = <circle key={segment.label} cx="72" cy="72" r="55" fill="none" stroke={segment.color} strokeWidth="17" strokeDasharray={`${Math.max(0, length - (length ? 3 : 0))} ${circumference}`} strokeDashoffset={-offset} transform="rotate(-90 72 72)"><title>{segment.label}: {segment.value}</title></circle>;
        offset += length;
        return circle;
      })}
      <text x="72" y="73" textAnchor="middle" className="donut-total">{orders.length}</text>
      <text x="72" y="91" textAnchor="middle" className="donut-label">total orders</text>
    </svg>
    <div className="donut-legend">{segments.map(segment => <div className="donut-legend-row" key={segment.label}><span className="chart-dot" style={{ background: segment.color }}/><span>{segment.label}</span><strong>{segment.value}</strong></div>)}</div>
  </div>;
}

export function WilayaChart({ orders }: { orders: Order[] }) {
  const counts = orders.reduce<Record<string, number>>((result, order) => {
    result[order.wilaya] = (result[order.wilaya] ?? 0) + 1;
    return result;
  }, {});
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!top.length) return <div className="chart-empty compact"><strong>Reach your first wilaya</strong><span>Your customer locations will appear here.</span></div>;
  return <div className="wilaya-chart" aria-label="Top wilayas by order volume">{top.map(([wilaya, count], index) => <div className="wilaya-row" key={wilaya}>
    <div className="wilaya-row-heading"><span><span className="wilaya-rank">{String(index + 1).padStart(2, '0')}</span>{wilaya}</span><span><strong>{count}</strong> <span className="wilaya-unit">orders</span></span></div>
    <div className="wilaya-track" role="meter" aria-label={`${wilaya} share of orders`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(count / orders.length * 100)}><span style={{ width: `${count / top[0][1] * 100}%`, background: ['#35694c', '#739369', '#a5bb8b', '#d2dec2'][index] }}/></div>
  </div>)}</div>;
}
