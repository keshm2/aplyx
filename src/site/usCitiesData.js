/* usCitiesData.js: plain-JS port of src/core/src/data/usCities.ts +
 * src/core/src/autocomplete.ts's fuzzy scorer, for the hosted signup form
 * (account.js), which has no build step and can't import the TS core
 * directly. Kept in sync by hand; both lists are short and change rarely.
 * See usCities.ts for the full curation rationale.
 */

export const US_CITIES = [
  "Remote",
  "San Francisco, CA", "San Jose, CA", "Palo Alto, CA", "Mountain View, CA", "Sunnyvale, CA",
  "Menlo Park, CA", "Redwood City, CA", "Oakland, CA", "Berkeley, CA", "Santa Clara, CA",
  "Cupertino, CA", "Fremont, CA", "San Mateo, CA", "Emeryville, CA", "Sacramento, CA",
  "Los Angeles, CA", "Santa Monica, CA", "Culver City, CA", "Pasadena, CA", "Irvine, CA",
  "San Diego, CA", "Long Beach, CA", "Anaheim, CA", "El Segundo, CA",
  "Seattle, WA", "Bellevue, WA", "Redmond, WA", "Kirkland, WA", "Tacoma, WA", "Spokane, WA",
  "Portland, OR", "Beaverton, OR", "Hillsboro, OR",
  "Austin, TX", "Dallas, TX", "Houston, TX", "San Antonio, TX", "Plano, TX", "Fort Worth, TX", "El Paso, TX",
  "Phoenix, AZ", "Tempe, AZ", "Scottsdale, AZ", "Tucson, AZ",
  "Denver, CO", "Boulder, CO", "Colorado Springs, CO",
  "Salt Lake City, UT", "Provo, UT", "Las Vegas, NV", "Reno, NV", "Albuquerque, NM",
  "Chicago, IL", "Evanston, IL", "Naperville, IL", "Minneapolis, MN", "St. Paul, MN",
  "Detroit, MI", "Ann Arbor, MI", "Grand Rapids, MI", "Columbus, OH", "Cincinnati, OH", "Cleveland, OH",
  "Indianapolis, IN", "Milwaukee, WI", "Madison, WI", "Kansas City, MO", "St. Louis, MO",
  "Omaha, NE", "Des Moines, IA",
  "New York, NY", "New York City, NY", "Brooklyn, NY", "Manhattan, NY", "Queens, NY",
  "Albany, NY", "Buffalo, NY", "Rochester, NY", "Boston, MA", "Cambridge, MA", "Somerville, MA",
  "Worcester, MA", "Providence, RI", "Hartford, CT", "Stamford, CT", "New Haven, CT",
  "Newark, NJ", "Jersey City, NJ", "Princeton, NJ", "Philadelphia, PA", "Pittsburgh, PA", "Portland, ME",
  "Washington, DC", "Arlington, VA", "Alexandria, VA", "Reston, VA", "McLean, VA", "Richmond, VA",
  "Baltimore, MD", "Bethesda, MD", "Rockville, MD", "Wilmington, DE",
  "Atlanta, GA", "Savannah, GA", "Charlotte, NC", "Raleigh, NC", "Durham, NC", "Chapel Hill, NC",
  "Charleston, SC", "Columbia, SC", "Nashville, TN", "Memphis, TN", "Knoxville, TN", "Chattanooga, TN",
  "Miami, FL", "Fort Lauderdale, FL", "Orlando, FL", "Tampa, FL", "Jacksonville, FL", "Tallahassee, FL",
  "Birmingham, AL", "New Orleans, LA", "Baton Rouge, LA", "Louisville, KY", "Little Rock, AR", "Jackson, MS",
  "Boise, ID", "Bozeman, MT", "Anchorage, AK", "Honolulu, HI",
  "Charlottesville, VA", "Lincoln, NE", "Wichita, KS", "Tulsa, OK", "Oklahoma City, OK",
  "Fayetteville, AR", "Huntsville, AL", "Montgomery, AL", "Greenville, SC", "Norfolk, VA",
  "Virginia Beach, VA", "Rochester, MN", "Fargo, ND", "Sioux Falls, SD", "Missoula, MT",
  "Bellingham, WA", "San Luis Obispo, CA", "Santa Barbara, CA", "Santa Cruz, CA",
  "Boulder Creek, CO", "Fort Collins, CO", "Ithaca, NY", "New Brunswick, NJ", "Bloomington, IN",
  "Champaign, IL", "State College, PA", "Blacksburg, VA", "College Station, TX", "Athens, GA", "Gainesville, FL",
  "Everett, WA", "Renton, WA", "Kent, WA", "Auburn, WA", "Federal Way, WA", "Bothell, WA",
  "Issaquah, WA", "Sammamish, WA", "Lynnwood, WA", "Marysville, WA", "Maple Valley, WA",
  "Shoreline, WA", "Edmonds, WA", "Puyallup, WA", "Olympia, WA", "Lacey, WA", "Bremerton, WA",
  "Kenmore, WA", "Woodinville, WA", "Mercer Island, WA", "Burien, WA", "Tukwila, WA", "SeaTac, WA",
  "Des Moines, WA", "Covington, WA", "Snoqualmie, WA", "North Bend, WA", "Monroe, WA",
  "Mill Creek, WA", "Mukilteo, WA", "Lake Stevens, WA", "Arlington, WA", "Bonney Lake, WA",
  "Vancouver, WA", "Richland, WA", "Kennewick, WA", "Yakima, WA", "Wenatchee, WA", "Walla Walla, WA", "Pullman, WA",
  "Hayward, CA", "Concord, CA", "Walnut Creek, CA", "Pleasanton, CA", "Dublin, CA", "Livermore, CA",
  "San Ramon, CA", "Milpitas, CA", "San Bruno, CA", "Daly City, CA", "Alameda, CA",
  "Roseville, CA", "Folsom, CA", "Elk Grove, CA", "Davis, CA",
  "Santa Ana, CA", "Burbank, CA", "Glendale, CA", "Torrance, CA", "Costa Mesa, CA", "Riverside, CA",
  "Ontario, CA", "Carlsbad, CA", "Chula Vista, CA", "Oceanside, CA", "Thousand Oaks, CA",
  "Gresham, OR", "Tigard, OR", "Lake Oswego, OR", "Eugene, OR", "Salem, OR", "Bend, OR",
  "Irving, TX", "Frisco, TX", "McKinney, TX", "Richardson, TX", "Arlington, TX", "Round Rock, TX",
  "Sugar Land, TX", "The Woodlands, TX", "Katy, TX", "Allen, TX", "Denton, TX", "San Marcos, TX",
  "Hoboken, NJ", "White Plains, NY", "Yonkers, NY", "Waltham, MA", "Burlington, MA", "Quincy, MA",
  "Tysons, VA", "Fairfax, VA", "Silver Spring, MD", "College Park, MD",
  "Aurora, CO", "Lakewood, CO", "Littleton, CO", "Broomfield, CO", "Lehi, UT", "Sandy, UT", "Ogden, UT",
  "Cary, NC", "Alpharetta, GA", "Marietta, GA", "Sandy Springs, GA", "Schaumburg, IL",
  "Bloomington, MN", "Eagan, MN", "Overland Park, KS", "Franklin, TN",
  "Coral Gables, FL", "Boca Raton, FL", "St. Petersburg, FL",
];

/** Population-weighted approximate centre of each US state; DC included.
 *  Used only to rank suggestions by rough proximity, never real distance. */
export const US_STATE_COORDS = {
  AL: [33.0, -86.8], AK: [61.2, -149.9], AZ: [33.4, -112.1], AR: [34.7, -92.3],
  CA: [37.4, -122.0], CO: [39.7, -104.9], CT: [41.3, -72.9], DE: [39.7, -75.6],
  DC: [38.9, -77.0], FL: [28.1, -81.5], GA: [33.7, -84.4], HI: [21.3, -157.8],
  ID: [43.6, -116.2], IL: [41.8, -87.7], IN: [39.8, -86.1], IA: [41.6, -93.6],
  KS: [38.9, -95.3], KY: [38.2, -85.7], LA: [30.0, -90.1], ME: [43.7, -70.3],
  MD: [39.1, -77.0], MA: [42.4, -71.1], MI: [42.7, -83.4], MN: [44.9, -93.2],
  MS: [32.3, -90.2], MO: [39.0, -94.4], MT: [45.8, -108.5], NE: [41.1, -96.1],
  NV: [39.4, -119.6], NH: [43.0, -71.5], NJ: [40.7, -74.1], NM: [35.1, -106.6],
  NY: [40.8, -73.9], NC: [35.8, -78.7], ND: [46.9, -96.8], OH: [40.0, -83.0],
  OK: [35.5, -97.5], OR: [45.4, -122.7], PA: [40.2, -76.9], RI: [41.8, -71.4],
  SC: [34.0, -81.0], SD: [43.5, -96.7], TN: [36.0, -86.7], TX: [30.4, -97.7],
  UT: [40.6, -111.9], VT: [44.5, -73.2], VA: [38.0, -78.5], WA: [47.5, -122.2],
  WV: [38.3, -81.6], WI: [43.3, -88.4], WY: [42.9, -106.3],
};

export function cityState(city) {
  const m = /,\s*([A-Z]{2})\s*$/.exec((city || "").trim());
  return m ? m[1] : "";
}

function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

/** Re-order `cities` so ones nearest `home` come first: exact home match,
 *  then same state, then by home-state -> candidate-state distance. A
 *  no-op (keeps curated order) when `home` has no recognizable state. */
export function rankCitiesByProximity(cities, home) {
  const homeState = cityState(home || "");
  const homeCoord = US_STATE_COORDS[homeState];
  if (!homeCoord) return cities;
  return rankCitiesByCoord(cities, homeCoord, (home || "").trim().toLowerCase());
}

/** Same ranking as rankCitiesByProximity, but from a raw [lat, lon]
 *  coordinate (e.g. the browser's real Geolocation position) instead of a
 *  "City, ST" string with no home city to treat as an exact/same-state
 *  match. */
export function rankCitiesByCoord(cities, coord, exactMatchNorm) {
  const score = (city) => {
    if (city === "Remote") return -2;
    if (exactMatchNorm && city.trim().toLowerCase() === exactMatchNorm) return -1;
    const st = cityState(city);
    const c = US_STATE_COORDS[st];
    return c ? haversineMiles(coord, c) : 99999;
  };
  return cities
    .map((city, i) => ({ city, i, s: score(city) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((e) => e.city);
}

// --- Fuzzy subsequence scorer, ported from src/core/src/autocomplete.ts ---

const BOUNDARY_BONUS = 10;
const CONSECUTIVE_BONUS = 3;
const MATCH_BONUS = 1;
const START_PENALTY = 0.5;
const PREFIX_BONUS = 50;

function isWordBoundaryChar(ch) {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

function fuzzyScore(query, text) {
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let firstMatchIndex = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) {
      consecutive = 0;
      continue;
    }
    if (firstMatchIndex === -1) firstMatchIndex = ti;
    score += MATCH_BONUS + consecutive * CONSECUTIVE_BONUS;
    if (isWordBoundaryChar(text[ti - 1])) score += BOUNDARY_BONUS;
    consecutive++;
    qi++;
  }
  if (qi < query.length) return null;
  score -= firstMatchIndex * START_PENALTY;
  if (text.startsWith(query)) score += PREFIX_BONUS;
  return score;
}

/** Same contract as core's filterSuggestions: fuzzy subsequence match,
 *  ranked, stable-sorted, top `limit`. Pool defaults to already-ranked
 *  US_CITIES order when no query. */
export function filterCities(query, pool, limit = 8) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return pool.slice(0, limit);
  const scored = [];
  for (const item of pool) {
    const s = fuzzyScore(q, item.toLowerCase());
    if (s !== null) scored.push({ item, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((e) => e.item);
}
