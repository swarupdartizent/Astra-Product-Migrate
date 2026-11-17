import { Building2, House } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { groupNavItems, navItems, visibleNavItems, type NavItem } from './navigation';

const items: NavItem[] = [
  { id: 'home', to: '/', label: 'Home', icon: House, permission: null, group: 'overview' },
  {
    id: 'restricted',
    to: '/',
    label: 'Restricted',
    icon: Building2,
    permission: 'example.read',
    group: 'platform',
  },
];

describe('navigation registry', () => {
  it('has unique ids and Home visible to every signed-in user', () => {
    const ids = navItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(navItems.find((item) => item.id === 'home')?.permission).toBeNull();
  });

  it('hides entries the user lacks permission for', () => {
    expect(visibleNavItems(new Set(), items).map((i) => i.id)).toEqual(['home']);
    expect(visibleNavItems(new Set(['example.read']), items).map((i) => i.id)).toEqual([
      'home',
      'restricted',
    ]);
  });

  it('drops groups with no visible entries', () => {
    const grouped = groupNavItems(visibleNavItems(new Set(), items));
    expect(grouped.map((g) => g.group.id)).toEqual(['overview']);
  });
});
