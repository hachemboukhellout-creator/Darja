export type Status = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'returned' | 'cancelled';
export interface Order {id:string; customer:string; phone:string; email:string; wilaya:string; address:string; product:string; quantity:number; amount:number; status:Status; carrier:string; createdAt:string; updatedAt:string; events?:{status:Status;at:string}[]}
export interface User {id:string;name:string;email:string;storeName:string;isDemo:boolean}
export interface Customer {id:string;name:string;phone:string;email:string;wilaya:string;orders:number;totalSpent:number;lastOrder:string}
export type Page = 'overview'|'orders'|'confirmation'|'deliveries'|'customers'|'analytics'|'settings';
export const statusLabels: Record<Status,string> = {pending:'Pending',confirmed:'Confirmed',shipped:'In transit',delivered:'Delivered',returned:'Returned',cancelled:'Cancelled'};
export const money = (n:number) => new Intl.NumberFormat('en-DZ',{maximumFractionDigits:2}).format(n);
export const dateLabel = (date:string) => new Date(date).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
export const initials = (name:string) => name.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase();
