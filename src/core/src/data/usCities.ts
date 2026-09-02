/**
 * Curated US city/state list for the onboarding wizard's location
 * autocomplete (home location + preferred job locations). Weighted
 * toward tech hubs since that's the actual applicant pool this app
 * serves, with broad enough state coverage that a freehand entry is
 * the exception rather than the rule. Plain `.ts` module (not JSON),
 * matches the rest of src/tui/src's no-data-JSON-import convention.
 *
 * "New York, NY" and "New York City, NY" are both listed deliberately:
 * people search either form, and autocomplete should surface whichever
 * one they start typing rather than silently collapsing to one.
 * Freehand text with no match is always accepted on Enter; this list
 * only drives suggestions, it's never a validated enum.
 *
 * The raw list is deduped at export because hand-curation by region has
 * produced accidental exact repeats (a city that belongs to two regional
 * groupings, e.g. "Durham, NC"), which showed up as duplicate suggestions
 * and duplicate React keys downstream.
 */
/**
 * Approximate centre of each US state (population-weighted, so it lands on
 * the state's main metro rather than its geographic middle). Used only to
 * rank location suggestions by rough proximity to the applicant's home
 * state - "type `re` while living in Redmond, WA and see Renton before
 * Reston" - never for anything that needs real distances. DC included.
 */
export const US_STATE_COORDS: Record<string, [number, number]> = {
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

/** The 2-letter state code from a "City, ST" string, or "" (e.g. "Remote"). */
export function cityState(city: string): string {
  const m = /,\s*([A-Z]{2})\s*$/.exec(city.trim());
  return m ? m[1]! : "";
}

function haversineMiles(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Re-order already-filtered city suggestions so the ones nearest the
 * applicant's home city come first: exact home match, then same state,
 * then by home-state -> candidate-state distance, stable within each tier.
 * A no-op when `home` has no recognizable state (keeps the input order,
 * i.e. the curated tech-hub weighting). "Remote" is always kept at the
 * top if present.
 */
export function rankCitiesByProximity(cities: string[], home: string): string[] {
  const homeState = cityState(home || "");
  const homeCoord = US_STATE_COORDS[homeState];
  if (!homeCoord) return cities;
  const homeNorm = (home || "").trim().toLowerCase();
  const score = (city: string): number => {
    if (city === "Remote") return -2;
    if (city.trim().toLowerCase() === homeNorm) return -1;
    const st = cityState(city);
    if (st === homeState) return 0;
    const c = US_STATE_COORDS[st];
    return c ? haversineMiles(homeCoord, c) : 99999;
  };
  return cities
    .map((city, i) => ({ city, i, s: score(city) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((e) => e.city);
}

const RAW_US_CITIES: string[] = [
  "Remote",

  // Bay Area / Northern California
  "San Francisco, CA",
  "San Jose, CA",
  "Palo Alto, CA",
  "Mountain View, CA",
  "Sunnyvale, CA",
  "Menlo Park, CA",
  "Redwood City, CA",
  "Oakland, CA",
  "Berkeley, CA",
  "Santa Clara, CA",
  "Cupertino, CA",
  "Fremont, CA",
  "San Mateo, CA",
  "Emeryville, CA",
  "Sacramento, CA",

  // Southern California
  "Los Angeles, CA",
  "Santa Monica, CA",
  "Culver City, CA",
  "Pasadena, CA",
  "Irvine, CA",
  "San Diego, CA",
  "Long Beach, CA",
  "Anaheim, CA",
  "El Segundo, CA",

  // Pacific Northwest
  "Seattle, WA",
  "Bellevue, WA",
  "Redmond, WA",
  "Kirkland, WA",
  "Tacoma, WA",
  "Spokane, WA",
  "Portland, OR",
  "Beaverton, OR",
  "Hillsboro, OR",

  // Southwest
  "Austin, TX",
  "Dallas, TX",
  "Houston, TX",
  "San Antonio, TX",
  "Plano, TX",
  "Fort Worth, TX",
  "El Paso, TX",
  "Phoenix, AZ",
  "Tempe, AZ",
  "Scottsdale, AZ",
  "Tucson, AZ",
  "Denver, CO",
  "Boulder, CO",
  "Colorado Springs, CO",
  "Salt Lake City, UT",
  "Provo, UT",
  "Las Vegas, NV",
  "Reno, NV",
  "Albuquerque, NM",

  // Midwest
  "Chicago, IL",
  "Evanston, IL",
  "Naperville, IL",
  "Minneapolis, MN",
  "St. Paul, MN",
  "Detroit, MI",
  "Ann Arbor, MI",
  "Grand Rapids, MI",
  "Columbus, OH",
  "Cincinnati, OH",
  "Cleveland, OH",
  "Indianapolis, IN",
  "Milwaukee, WI",
  "Madison, WI",
  "Kansas City, MO",
  "St. Louis, MO",
  "Omaha, NE",
  "Des Moines, IA",

  // Northeast
  "New York, NY",
  "New York City, NY",
  "Brooklyn, NY",
  "Manhattan, NY",
  "Queens, NY",
  "Albany, NY",
  "Buffalo, NY",
  "Rochester, NY",
  "Boston, MA",
  "Cambridge, MA",
  "Somerville, MA",
  "Worcester, MA",
  "Providence, RI",
  "Hartford, CT",
  "Stamford, CT",
  "New Haven, CT",
  "Newark, NJ",
  "Jersey City, NJ",
  "Princeton, NJ",
  "Philadelphia, PA",
  "Pittsburgh, PA",
  "Portland, ME",

  // Mid-Atlantic / DC
  "Washington, DC",
  "Arlington, VA",
  "Alexandria, VA",
  "Reston, VA",
  "McLean, VA",
  "Richmond, VA",
  "Baltimore, MD",
  "Bethesda, MD",
  "Rockville, MD",
  "Wilmington, DE",

  // Southeast
  "Atlanta, GA",
  "Savannah, GA",
  "Charlotte, NC",
  "Raleigh, NC",
  "Durham, NC",
  "Chapel Hill, NC",
  "Charleston, SC",
  "Columbia, SC",
  "Nashville, TN",
  "Memphis, TN",
  "Knoxville, TN",
  "Chattanooga, TN",
  "Miami, FL",
  "Fort Lauderdale, FL",
  "Orlando, FL",
  "Tampa, FL",
  "Jacksonville, FL",
  "Tallahassee, FL",
  "Birmingham, AL",
  "New Orleans, LA",
  "Baton Rouge, LA",
  "Louisville, KY",
  "Little Rock, AR",
  "Jackson, MS",

  // Mountain West / other
  "Boise, ID",
  "Bozeman, MT",
  "Anchorage, AK",
  "Honolulu, HI",

  // More state-capital / mid-size coverage so a freehand miss is rare
  "Charlottesville, VA",
  "Lincoln, NE",
  "Wichita, KS",
  "Tulsa, OK",
  "Oklahoma City, OK",
  "Fayetteville, AR",
  "Huntsville, AL",
  "Montgomery, AL",
  "Greenville, SC",
  "Norfolk, VA",
  "Virginia Beach, VA",
  "Rochester, MN",
  "Fargo, ND",
  "Sioux Falls, SD",
  "Missoula, MT",

  // Additional tech-adjacent / satellite hubs
  "Bellingham, WA",
  "San Luis Obispo, CA",
  "Santa Barbara, CA",
  "Santa Cruz, CA",
  "Boulder Creek, CO",
  "Fort Collins, CO",
  "Ithaca, NY",
  "New Brunswick, NJ",
  "Bloomington, IN",
  "Champaign, IL",
  "State College, PA",
  "Blacksburg, VA",
  "College Station, TX",
  "Athens, GA",
  "Gainesville, FL",

  // Metro suburbs and mid-size cities. People live in (and set their home
  // location to) the suburb, not the metro's headline city: this list had
  // exactly 7 Washington entries and none of Marysville, Lynnwood, Everett
  // or Maple Valley, so ordinary Puget Sound addresses had no suggestion at
  // all. Freehand still covers whatever is missing (see below), but a list
  // that misses the commuter belt of its own core metro makes the field
  // feel broken.

  // Puget Sound
  "Everett, WA",
  "Renton, WA",
  "Kent, WA",
  "Auburn, WA",
  "Federal Way, WA",
  "Bothell, WA",
  "Issaquah, WA",
  "Sammamish, WA",
  "Lynnwood, WA",
  "Marysville, WA",
  "Maple Valley, WA",
  "Shoreline, WA",
  "Edmonds, WA",
  "Puyallup, WA",
  "Olympia, WA",
  "Lacey, WA",
  "Bremerton, WA",
  "Kenmore, WA",
  "Woodinville, WA",
  "Mercer Island, WA",
  "Burien, WA",
  "Tukwila, WA",
  "SeaTac, WA",
  "Des Moines, WA",
  "Covington, WA",
  "Snoqualmie, WA",
  "North Bend, WA",
  "Monroe, WA",
  "Mill Creek, WA",
  "Mukilteo, WA",
  "Lake Stevens, WA",
  "Arlington, WA",
  "Bonney Lake, WA",
  "Vancouver, WA",
  "Richland, WA",
  "Kennewick, WA",
  "Yakima, WA",
  "Wenatchee, WA",
  "Walla Walla, WA",
  "Pullman, WA",

  // Bay Area / Sacramento
  "Fremont, CA",
  "Hayward, CA",
  "Concord, CA",
  "Walnut Creek, CA",
  "Pleasanton, CA",
  "Dublin, CA",
  "Livermore, CA",
  "San Ramon, CA",
  "Milpitas, CA",
  "Santa Clara, CA",
  "Cupertino, CA",
  "Redwood City, CA",
  "San Bruno, CA",
  "Daly City, CA",
  "Berkeley, CA",
  "Emeryville, CA",
  "Alameda, CA",
  "Roseville, CA",
  "Folsom, CA",
  "Elk Grove, CA",
  "Davis, CA",

  // Southern California
  "Irvine, CA",
  "Anaheim, CA",
  "Santa Ana, CA",
  "Long Beach, CA",
  "Pasadena, CA",
  "Burbank, CA",
  "Glendale, CA",
  "Torrance, CA",
  "Costa Mesa, CA",
  "Riverside, CA",
  "Ontario, CA",
  "Carlsbad, CA",
  "Chula Vista, CA",
  "Oceanside, CA",
  "Thousand Oaks, CA",
  "El Segundo, CA",

  // Portland
  "Beaverton, OR",
  "Hillsboro, OR",
  "Gresham, OR",
  "Tigard, OR",
  "Lake Oswego, OR",
  "Eugene, OR",
  "Salem, OR",
  "Bend, OR",

  // Texas
  "Plano, TX",
  "Irving, TX",
  "Frisco, TX",
  "McKinney, TX",
  "Richardson, TX",
  "Arlington, TX",
  "Fort Worth, TX",
  "Round Rock, TX",
  "Sugar Land, TX",
  "The Woodlands, TX",
  "Katy, TX",
  "Allen, TX",
  "Denton, TX",
  "San Marcos, TX",

  // NYC metro / Northeast
  "Jersey City, NJ",
  "Hoboken, NJ",
  "Newark, NJ",
  "Stamford, CT",
  "White Plains, NY",
  "Brooklyn, NY",
  "Queens, NY",
  "Yonkers, NY",
  "Cambridge, MA",
  "Somerville, MA",
  "Waltham, MA",
  "Burlington, MA",
  "Quincy, MA",
  "Providence, RI",

  // DC metro
  "Alexandria, VA",
  "Reston, VA",
  "McLean, VA",
  "Tysons, VA",
  "Fairfax, VA",
  "Bethesda, MD",
  "Rockville, MD",
  "Silver Spring, MD",
  "College Park, MD",

  // Denver / Mountain West
  "Boulder, CO",
  "Aurora, CO",
  "Lakewood, CO",
  "Littleton, CO",
  "Broomfield, CO",
  "Provo, UT",
  "Lehi, UT",
  "Sandy, UT",
  "Ogden, UT",

  // Southeast / Midwest suburbs
  "Cary, NC",
  "Durham, NC",
  "Chapel Hill, NC",
  "Alpharetta, GA",
  "Marietta, GA",
  "Sandy Springs, GA",
  "Naperville, IL",
  "Evanston, IL",
  "Schaumburg, IL",
  "Ann Arbor, MI",
  "Bloomington, MN",
  "Eagan, MN",
  "Overland Park, KS",
  "Franklin, TN",
  "Coral Gables, FL",
  "Boca Raton, FL",
  "St. Petersburg, FL",
];

export const US_CITIES: string[] = [...new Set(RAW_US_CITIES)];
