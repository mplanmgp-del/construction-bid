import { describe, expect, it } from 'vitest';
import { appViewFromHash, appViewHash, menuIsLocked } from '../src/admin/navigation';
import { APP_MENUS } from '../src/admin/types';
const settings = APP_MENUS.map(menu => ({ menu_key: menu.key, locked: menu.key === 'results', message: '', updated_at: '' }));

describe('menu access including direct links', () => {
  it('maps direct admin and MY links into the guarded views', () => {
    expect(appViewFromHash('#admin')).toBe('admin'); expect(appViewFromHash('#my-bids')).toBe('results');
    expect(appViewFromHash('#unrecognized')).toBe('notices');
    expect(appViewHash('results')).toBe('#my-bids');
  });
  it('blocks MY for ordinary members, allows confirmed administrators, and blocks until loaded', () => {
    expect(menuIsLocked('results', true, false, settings)).toBe(true);
    expect(menuIsLocked('notices', true, false, settings)).toBe(false);
    expect(menuIsLocked('results', true, true, settings)).toBe(false);
    expect(menuIsLocked('results', false, true, settings)).toBe(true);
    expect(menuIsLocked('profile', true, false, [])).toBe(true);
  });
  it('keeps sign-in and the admin authorization screen reachable when menus are locked', () => {
    expect(menuIsLocked('account', false, false, [])).toBe(false);
    expect(menuIsLocked('admin', false, false, [])).toBe(false);
  });
});


describe('retired custom search links',()=>{
  it('redirects a retired custom-search link to the notices page and its permissions',()=>{
    expect(appViewFromHash('#custom-search')).toBe('notices');
    expect(appViewHash(appViewFromHash('#custom-search'))).toBe('');
    expect(menuIsLocked(appViewFromHash('#custom-search'),true,false,settings)).toBe(false);
    expect(menuIsLocked(appViewFromHash('#custom-search'),true,false,settings.map(s=>({...s,locked:true})))).toBe(true);
    expect(menuIsLocked(appViewFromHash('#custom-search'),false,true,settings)).toBe(true);
  });
});
