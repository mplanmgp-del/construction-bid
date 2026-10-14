import directory from './data/administrative-regions.json';

/** Official administrative neighbourhoods; these are not cadastral/legal dong boundaries. */
export const REGION_DIRECTORY_SOURCE = {
  title: directory.title,
  url: directory.sourceUrl,
  asOf: directory.asOf,
  localityCount: directory.rows.length,
};

const compare = (first: string, second: string) => first.localeCompare(second, 'ko', { numeric: true });
const byProvince = new Map<string, Map<string, Set<string>>>();

for (const [, province, sourceDistrict, locality] of directory.rows) {
  // Sejong has no city/district level. Keep a selectable UI bucket, without altering the source.
  const district = sourceDistrict || (province === '세종특별자치시' ? '세종시' : '');
  let districts = byProvince.get(province);
  if (!districts) { districts = new Map(); byProvince.set(province, districts); }
  let localities = districts.get(district);
  if (!localities) { localities = new Set(); districts.set(district, localities); }
  localities.add(locality);

  const [city, ...wards] = district.split(' ');
  if (city.endsWith('시') && wards.length) {
    // Also allow a whole city, while retaining the ward in each child locality's path.
    let cityLocalities = districts.get(city);
    if (!cityLocalities) { cityLocalities = new Set(); districts.set(city, cityLocalities); }
    cityLocalities.add(`${wards.join(' ')} ${locality}`);
  }
}

/** Preserve the official province ordering, avoiding a duplicated hard-coded catalogue. */
export const REGION_PROVINCES: string[] = [...byProvince.keys()];

/** Includes whole cities and their named administrative wards, e.g. 수원시 / 수원시 장안구. */
export function regionDistricts(province: string): string[] {
  return [...(byProvince.get(province)?.keys() || [])].sort(compare);
}

/** Whole-city selection returns ward-qualified children so the complete path remains unambiguous. */
export function regionLocalities(province: string, district: string): string[] {
  return [...(byProvince.get(province)?.get(district) || [])].sort(compare);
}
