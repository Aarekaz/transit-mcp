/**
 * NYC Subway static station data
 * Generated from GTFS static feed
 *
 * Source: MTA GTFS Static Data
 * Generated: 2025-12-27T16:05:59.557Z
 * Total Stations: 496
 */

import { TransitStation } from './base';

export const NYC_STATIONS: TransitStation[] = [
  {
    id: '101',
    name: 'Van Cortlandt Park-242 St',
    city: 'nyc',
    latitude: 40.889248,
    longitude: -73.898583,
    lines: ['1'],
    childPlatforms: ['101N', '101S']
  },
  {
    id: '103',
    name: '238 St',
    city: 'nyc',
    latitude: 40.884667,
    longitude: -73.90087,
    lines: ['1'],
    childPlatforms: ['103N', '103S']
  },
  {
    id: '104',
    name: '231 St',
    city: 'nyc',
    latitude: 40.878856,
    longitude: -73.904834,
    lines: ['1'],
    childPlatforms: ['104N', '104S']
  },
  {
    id: '106',
    name: 'Marble Hill-225 St',
    city: 'nyc',
    latitude: 40.874561,
    longitude: -73.909831,
    lines: ['1'],
    childPlatforms: ['106N', '106S']
  },
  {
    id: '107',
    name: '215 St',
    city: 'nyc',
    latitude: 40.869444,
    longitude: -73.915279,
    lines: ['1'],
    childPlatforms: ['107N', '107S']
  },
  {
    id: '108',
    name: '207 St',
    city: 'nyc',
    latitude: 40.864621,
    longitude: -73.918822,
    lines: ['1'],
    childPlatforms: ['108N', '108S']
  },
  {
    id: '109',
    name: 'Dyckman St',
    city: 'nyc',
    latitude: 40.860531,
    longitude: -73.925536,
    lines: ['1'],
    childPlatforms: ['109N', '109S']
  },
  {
    id: '110',
    name: '191 St',
    city: 'nyc',
    latitude: 40.855225,
    longitude: -73.929412,
    lines: ['1'],
    childPlatforms: ['110N', '110S']
  },
  {
    id: '111',
    name: '181 St',
    city: 'nyc',
    latitude: 40.849505,
    longitude: -73.933596,
    lines: ['1'],
    childPlatforms: ['111N', '111S']
  },
  {
    id: '112',
    name: '168 St-Washington Hts',
    city: 'nyc',
    latitude: 40.840556,
    longitude: -73.940133,
    lines: ['1'],
    childPlatforms: ['112N', '112S'],
    transfers: [
      { toStationId: 'A09', toStationName: '168 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '113',
    name: '157 St',
    city: 'nyc',
    latitude: 40.834041,
    longitude: -73.94489,
    lines: ['1'],
    childPlatforms: ['113N', '113S']
  },
  {
    id: '114',
    name: '145 St',
    city: 'nyc',
    latitude: 40.826551,
    longitude: -73.95036,
    lines: ['1'],
    childPlatforms: ['114N', '114S']
  },
  {
    id: '115',
    name: '137 St-City College',
    city: 'nyc',
    latitude: 40.822008,
    longitude: -73.953676,
    lines: ['1'],
    childPlatforms: ['115N', '115S']
  },
  {
    id: '116',
    name: '125 St',
    city: 'nyc',
    latitude: 40.815581,
    longitude: -73.958372,
    lines: ['1'],
    childPlatforms: ['116N', '116S']
  },
  {
    id: '117',
    name: '116 St-Columbia University',
    city: 'nyc',
    latitude: 40.807722,
    longitude: -73.96411,
    lines: ['1'],
    childPlatforms: ['117N', '117S']
  },
  {
    id: '118',
    name: 'Cathedral Pkwy (110 St)',
    city: 'nyc',
    latitude: 40.803967,
    longitude: -73.966847,
    lines: ['1'],
    childPlatforms: ['118N', '118S']
  },
  {
    id: '119',
    name: '103 St',
    city: 'nyc',
    latitude: 40.799446,
    longitude: -73.968379,
    lines: ['1'],
    childPlatforms: ['119N', '119S']
  },
  {
    id: '120',
    name: '96 St',
    city: 'nyc',
    latitude: 40.793919,
    longitude: -73.972323,
    lines: ['1', '2', '3'],
    childPlatforms: ['120N', '120S']
  },
  {
    id: '121',
    name: '86 St',
    city: 'nyc',
    latitude: 40.788644,
    longitude: -73.976218,
    lines: ['1', '2'],
    childPlatforms: ['121N', '121S']
  },
  {
    id: '122',
    name: '79 St',
    city: 'nyc',
    latitude: 40.783934,
    longitude: -73.979917,
    lines: ['1', '2'],
    childPlatforms: ['122N', '122S']
  },
  {
    id: '123',
    name: '72 St',
    city: 'nyc',
    latitude: 40.778453,
    longitude: -73.98197,
    lines: ['1', '2', '3'],
    childPlatforms: ['123N', '123S']
  },
  {
    id: '124',
    name: '66 St-Lincoln Center',
    city: 'nyc',
    latitude: 40.77344,
    longitude: -73.982209,
    lines: ['1', '2'],
    childPlatforms: ['124N', '124S']
  },
  {
    id: '125',
    name: '59 St-Columbus Circle',
    city: 'nyc',
    latitude: 40.768247,
    longitude: -73.981929,
    lines: ['1', '2'],
    childPlatforms: ['125N', '125S'],
    transfers: [
      { toStationId: 'A24', toStationName: '59 St-Columbus Circle', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '126',
    name: '50 St',
    city: 'nyc',
    latitude: 40.761728,
    longitude: -73.983849,
    lines: ['1', '2'],
    childPlatforms: ['126N', '126S']
  },
  {
    id: '127',
    name: 'Times Sq-42 St',
    city: 'nyc',
    latitude: 40.75529,
    longitude: -73.987495,
    lines: ['1', '2', '3'],
    childPlatforms: ['127N', '127S'],
    transfers: [
      { toStationId: '725', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '902', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R16', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'A27', toStationName: '42 St-Port Authority Bus Terminal', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '128',
    name: '34 St-Penn Station',
    city: 'nyc',
    latitude: 40.750373,
    longitude: -73.991057,
    lines: ['1', '2', '3'],
    childPlatforms: ['128N', '128S']
  },
  {
    id: '129',
    name: '28 St',
    city: 'nyc',
    latitude: 40.747215,
    longitude: -73.993365,
    lines: ['1', '2'],
    childPlatforms: ['129N', '129S']
  },
  {
    id: '130',
    name: '23 St',
    city: 'nyc',
    latitude: 40.744081,
    longitude: -73.995657,
    lines: ['1', '2'],
    childPlatforms: ['130N', '130S']
  },
  {
    id: '131',
    name: '18 St',
    city: 'nyc',
    latitude: 40.74104,
    longitude: -73.997871,
    lines: ['1', '2'],
    childPlatforms: ['131N', '131S']
  },
  {
    id: '132',
    name: '14 St',
    city: 'nyc',
    latitude: 40.737826,
    longitude: -74.000201,
    lines: ['1', '2', '3'],
    childPlatforms: ['132N', '132S'],
    transfers: [
      { toStationId: 'L02', toStationName: '6 Av', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'D19', toStationName: '14 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '133',
    name: 'Christopher St-Stonewall',
    city: 'nyc',
    latitude: 40.733422,
    longitude: -74.002906,
    lines: ['1', '2'],
    childPlatforms: ['133N', '133S']
  },
  {
    id: '134',
    name: 'Houston St',
    city: 'nyc',
    latitude: 40.728251,
    longitude: -74.005367,
    lines: ['1', '2'],
    childPlatforms: ['134N', '134S']
  },
  {
    id: '135',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.722854,
    longitude: -74.006277,
    lines: ['1', '2'],
    childPlatforms: ['135N', '135S']
  },
  {
    id: '136',
    name: 'Franklin St',
    city: 'nyc',
    latitude: 40.719318,
    longitude: -74.006886,
    lines: ['1', '2'],
    childPlatforms: ['136N', '136S']
  },
  {
    id: '137',
    name: 'Chambers St',
    city: 'nyc',
    latitude: 40.715478,
    longitude: -74.009266,
    lines: ['1', '2', '3'],
    childPlatforms: ['137N', '137S']
  },
  {
    id: '138',
    name: 'WTC Cortlandt',
    city: 'nyc',
    latitude: 40.711835,
    longitude: -74.012188,
    lines: ['1'],
    childPlatforms: ['138N', '138S']
  },
  {
    id: '139',
    name: 'Rector St',
    city: 'nyc',
    latitude: 40.707513,
    longitude: -74.013783,
    lines: ['1'],
    childPlatforms: ['139N', '139S']
  },
  {
    id: '142',
    name: 'South Ferry',
    city: 'nyc',
    latitude: 40.702068,
    longitude: -74.013664,
    lines: ['1'],
    childPlatforms: ['142N', '142S']
  },
  {
    id: '201',
    name: 'Wakefield-241 St',
    city: 'nyc',
    latitude: 40.903125,
    longitude: -73.85062,
    lines: ['2'],
    childPlatforms: ['201N', '201S']
  },
  {
    id: '204',
    name: 'Nereid Av',
    city: 'nyc',
    latitude: 40.898379,
    longitude: -73.854376,
    lines: ['2', '5'],
    childPlatforms: ['204N', '204S']
  },
  {
    id: '205',
    name: '233 St',
    city: 'nyc',
    latitude: 40.893193,
    longitude: -73.857473,
    lines: ['2', '5'],
    childPlatforms: ['205N', '205S']
  },
  {
    id: '206',
    name: '225 St',
    city: 'nyc',
    latitude: 40.888022,
    longitude: -73.860341,
    lines: ['2', '5'],
    childPlatforms: ['206N', '206S']
  },
  {
    id: '207',
    name: '219 St',
    city: 'nyc',
    latitude: 40.883895,
    longitude: -73.862633,
    lines: ['2', '5'],
    childPlatforms: ['207N', '207S']
  },
  {
    id: '208',
    name: 'Gun Hill Rd',
    city: 'nyc',
    latitude: 40.87785,
    longitude: -73.866256,
    lines: ['2', '5'],
    childPlatforms: ['208N', '208S']
  },
  {
    id: '209',
    name: 'Burke Av',
    city: 'nyc',
    latitude: 40.871356,
    longitude: -73.867164,
    lines: ['2', '5'],
    childPlatforms: ['209N', '209S']
  },
  {
    id: '210',
    name: 'Allerton Av',
    city: 'nyc',
    latitude: 40.865462,
    longitude: -73.867352,
    lines: ['2', '5'],
    childPlatforms: ['210N', '210S']
  },
  {
    id: '211',
    name: 'Pelham Pkwy',
    city: 'nyc',
    latitude: 40.857192,
    longitude: -73.867615,
    lines: ['2', '5'],
    childPlatforms: ['211N', '211S']
  },
  {
    id: '212',
    name: 'Bronx Park East',
    city: 'nyc',
    latitude: 40.848828,
    longitude: -73.868457,
    lines: ['2', '5'],
    childPlatforms: ['212N', '212S']
  },
  {
    id: '213',
    name: 'E 180 St',
    city: 'nyc',
    latitude: 40.841894,
    longitude: -73.873488,
    lines: ['2', '5'],
    childPlatforms: ['213N', '213S']
  },
  {
    id: '214',
    name: 'West Farms Sq-E Tremont Av',
    city: 'nyc',
    latitude: 40.840295,
    longitude: -73.880049,
    lines: ['2', '5'],
    childPlatforms: ['214N', '214S']
  },
  {
    id: '215',
    name: '174 St',
    city: 'nyc',
    latitude: 40.837288,
    longitude: -73.887734,
    lines: ['2', '5'],
    childPlatforms: ['215N', '215S']
  },
  {
    id: '216',
    name: 'Freeman St',
    city: 'nyc',
    latitude: 40.829993,
    longitude: -73.891865,
    lines: ['2', '5'],
    childPlatforms: ['216N', '216S']
  },
  {
    id: '217',
    name: 'Simpson St',
    city: 'nyc',
    latitude: 40.824073,
    longitude: -73.893064,
    lines: ['2', '5'],
    childPlatforms: ['217N', '217S']
  },
  {
    id: '218',
    name: 'Intervale Av',
    city: 'nyc',
    latitude: 40.822181,
    longitude: -73.896736,
    lines: ['2', '5'],
    childPlatforms: ['218N', '218S']
  },
  {
    id: '219',
    name: 'Prospect Av',
    city: 'nyc',
    latitude: 40.819585,
    longitude: -73.90177,
    lines: ['2', '5'],
    childPlatforms: ['219N', '219S']
  },
  {
    id: '220',
    name: 'Jackson Av',
    city: 'nyc',
    latitude: 40.81649,
    longitude: -73.907807,
    lines: ['2', '5'],
    childPlatforms: ['220N', '220S']
  },
  {
    id: '221',
    name: '3 Av-149 St',
    city: 'nyc',
    latitude: 40.816109,
    longitude: -73.917757,
    lines: ['2', '5'],
    childPlatforms: ['221N', '221S']
  },
  {
    id: '222',
    name: '149 St-Grand Concourse',
    city: 'nyc',
    latitude: 40.81841,
    longitude: -73.926718,
    lines: ['2', '5'],
    childPlatforms: ['222N', '222S'],
    transfers: [
      { toStationId: '415', toStationName: '149 St-Grand Concourse', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '224',
    name: '135 St',
    city: 'nyc',
    latitude: 40.814229,
    longitude: -73.94077,
    lines: ['2', '3'],
    childPlatforms: ['224N', '224S']
  },
  {
    id: '225',
    name: '125 St',
    city: 'nyc',
    latitude: 40.807754,
    longitude: -73.945495,
    lines: ['2', '3'],
    childPlatforms: ['225N', '225S']
  },
  {
    id: '226',
    name: '116 St',
    city: 'nyc',
    latitude: 40.802098,
    longitude: -73.949625,
    lines: ['2', '3'],
    childPlatforms: ['226N', '226S']
  },
  {
    id: '227',
    name: '110 St-Malcolm X Plaza',
    city: 'nyc',
    latitude: 40.799075,
    longitude: -73.951822,
    lines: ['2', '3'],
    childPlatforms: ['227N', '227S']
  },
  {
    id: '228',
    name: 'Park Place',
    city: 'nyc',
    latitude: 40.713051,
    longitude: -74.008811,
    lines: ['2', '3'],
    childPlatforms: ['228N', '228S'],
    transfers: [
      { toStationId: 'A36', toStationName: 'Chambers St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'E01', toStationName: 'World Trade Center', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R25', toStationName: 'Cortlandt St', transferTime: 420, transferType: 'nearby' }
    ]
  },
  {
    id: '229',
    name: 'Fulton St',
    city: 'nyc',
    latitude: 40.709416,
    longitude: -74.006571,
    lines: ['2', '3'],
    childPlatforms: ['229N', '229S'],
    transfers: [
      { toStationId: 'A38', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '418', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'M22', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '230',
    name: 'Wall St',
    city: 'nyc',
    latitude: 40.706821,
    longitude: -74.0091,
    lines: ['2', '3'],
    childPlatforms: ['230N', '230S']
  },
  {
    id: '231',
    name: 'Clark St',
    city: 'nyc',
    latitude: 40.697466,
    longitude: -73.993086,
    lines: ['2', '3'],
    childPlatforms: ['231N', '231S']
  },
  {
    id: '232',
    name: 'Borough Hall',
    city: 'nyc',
    latitude: 40.693219,
    longitude: -73.989998,
    lines: ['2', '3'],
    childPlatforms: ['232N', '232S'],
    transfers: [
      { toStationId: 'R28', toStationName: 'Court St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '423', toStationName: 'Borough Hall', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '233',
    name: 'Hoyt St',
    city: 'nyc',
    latitude: 40.690545,
    longitude: -73.985065,
    lines: ['2', '3'],
    childPlatforms: ['233N', '233S']
  },
  {
    id: '234',
    name: 'Nevins St',
    city: 'nyc',
    latitude: 40.688246,
    longitude: -73.980492,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['234N', '234S']
  },
  {
    id: '235',
    name: 'Atlantic Av-Barclays Ctr',
    city: 'nyc',
    latitude: 40.684359,
    longitude: -73.977666,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['235N', '235S'],
    transfers: [
      { toStationId: 'D24', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R31', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '236',
    name: 'Bergen St',
    city: 'nyc',
    latitude: 40.680829,
    longitude: -73.975098,
    lines: ['2', '3', '4'],
    childPlatforms: ['236N', '236S']
  },
  {
    id: '237',
    name: 'Grand Army Plaza',
    city: 'nyc',
    latitude: 40.675235,
    longitude: -73.971046,
    lines: ['2', '3', '4'],
    childPlatforms: ['237N', '237S']
  },
  {
    id: '238',
    name: 'Eastern Pkwy-Brooklyn Museum',
    city: 'nyc',
    latitude: 40.671987,
    longitude: -73.964375,
    lines: ['2', '3', '4'],
    childPlatforms: ['238N', '238S']
  },
  {
    id: '239',
    name: 'Franklin Av-Medgar Evers College',
    city: 'nyc',
    latitude: 40.670682,
    longitude: -73.958131,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['239N', '239S'],
    transfers: [
      { toStationId: 'S04', toStationName: 'Botanic Garden', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '241',
    name: 'President St-Medgar Evers College',
    city: 'nyc',
    latitude: 40.667883,
    longitude: -73.950683,
    lines: ['2', '5'],
    childPlatforms: ['241N', '241S']
  },
  {
    id: '242',
    name: 'Sterling St',
    city: 'nyc',
    latitude: 40.662742,
    longitude: -73.95085,
    lines: ['2', '5'],
    childPlatforms: ['242N', '242S']
  },
  {
    id: '243',
    name: 'Winthrop St',
    city: 'nyc',
    latitude: 40.656652,
    longitude: -73.9502,
    lines: ['2', '5'],
    childPlatforms: ['243N', '243S']
  },
  {
    id: '244',
    name: 'Church Av',
    city: 'nyc',
    latitude: 40.650843,
    longitude: -73.949575,
    lines: ['2', '5'],
    childPlatforms: ['244N', '244S']
  },
  {
    id: '245',
    name: 'Beverly Rd',
    city: 'nyc',
    latitude: 40.645098,
    longitude: -73.948959,
    lines: ['2', '5'],
    childPlatforms: ['245N', '245S']
  },
  {
    id: '246',
    name: 'Newkirk Av-Little Haiti',
    city: 'nyc',
    latitude: 40.639967,
    longitude: -73.948411,
    lines: ['2', '5'],
    childPlatforms: ['246N', '246S']
  },
  {
    id: '247',
    name: 'Flatbush Av-Brooklyn College',
    city: 'nyc',
    latitude: 40.632836,
    longitude: -73.947642,
    lines: ['2', '5'],
    childPlatforms: ['247N', '247S']
  },
  {
    id: '248',
    name: 'Nostrand Av',
    city: 'nyc',
    latitude: 40.669847,
    longitude: -73.950466,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['248N', '248S']
  },
  {
    id: '249',
    name: 'Kingston Av',
    city: 'nyc',
    latitude: 40.669399,
    longitude: -73.942161,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['249N', '249S']
  },
  {
    id: '250',
    name: 'Crown Hts-Utica Av',
    city: 'nyc',
    latitude: 40.668897,
    longitude: -73.932942,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['250N', '250S']
  },
  {
    id: '251',
    name: 'Sutter Av-Rutland Rd',
    city: 'nyc',
    latitude: 40.664717,
    longitude: -73.92261,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['251N', '251S']
  },
  {
    id: '252',
    name: 'Saratoga Av',
    city: 'nyc',
    latitude: 40.661453,
    longitude: -73.916327,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['252N', '252S']
  },
  {
    id: '253',
    name: 'Rockaway Av',
    city: 'nyc',
    latitude: 40.662549,
    longitude: -73.908946,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['253N', '253S']
  },
  {
    id: '254',
    name: 'Junius St',
    city: 'nyc',
    latitude: 40.663515,
    longitude: -73.902447,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['254N', '254S'],
    transfers: [
      { toStationId: 'L26', toStationName: 'Livonia Av', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '255',
    name: 'Pennsylvania Av',
    city: 'nyc',
    latitude: 40.664635,
    longitude: -73.894895,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['255N', '255S']
  },
  {
    id: '256',
    name: 'Van Siclen Av',
    city: 'nyc',
    latitude: 40.665449,
    longitude: -73.889395,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['256N', '256S']
  },
  {
    id: '257',
    name: 'New Lots Av',
    city: 'nyc',
    latitude: 40.666235,
    longitude: -73.884079,
    lines: ['2', '3', '4', '5'],
    childPlatforms: ['257N', '257S']
  },
  {
    id: '301',
    name: 'Harlem-148 St',
    city: 'nyc',
    latitude: 40.82388,
    longitude: -73.93647,
    lines: ['3'],
    childPlatforms: ['301N', '301S']
  },
  {
    id: '302',
    name: '145 St',
    city: 'nyc',
    latitude: 40.820421,
    longitude: -73.936245,
    lines: ['3'],
    childPlatforms: ['302N', '302S']
  },
  {
    id: '401',
    name: 'Woodlawn',
    city: 'nyc',
    latitude: 40.886037,
    longitude: -73.878751,
    lines: ['4'],
    childPlatforms: ['401N', '401S']
  },
  {
    id: '402',
    name: 'Mosholu Pkwy',
    city: 'nyc',
    latitude: 40.87975,
    longitude: -73.884655,
    lines: ['4'],
    childPlatforms: ['402N', '402S']
  },
  {
    id: '405',
    name: 'Bedford Park Blvd-Lehman College',
    city: 'nyc',
    latitude: 40.873412,
    longitude: -73.890064,
    lines: ['4'],
    childPlatforms: ['405N', '405S']
  },
  {
    id: '406',
    name: 'Kingsbridge Rd',
    city: 'nyc',
    latitude: 40.86776,
    longitude: -73.897174,
    lines: ['4'],
    childPlatforms: ['406N', '406S']
  },
  {
    id: '407',
    name: 'Fordham Rd',
    city: 'nyc',
    latitude: 40.862803,
    longitude: -73.901034,
    lines: ['4'],
    childPlatforms: ['407N', '407S']
  },
  {
    id: '408',
    name: '183 St',
    city: 'nyc',
    latitude: 40.858407,
    longitude: -73.903879,
    lines: ['4'],
    childPlatforms: ['408N', '408S']
  },
  {
    id: '409',
    name: 'Burnside Av',
    city: 'nyc',
    latitude: 40.853453,
    longitude: -73.907684,
    lines: ['4'],
    childPlatforms: ['409N', '409S']
  },
  {
    id: '410',
    name: '176 St',
    city: 'nyc',
    latitude: 40.84848,
    longitude: -73.911794,
    lines: ['4'],
    childPlatforms: ['410N', '410S']
  },
  {
    id: '411',
    name: 'Mt Eden Av',
    city: 'nyc',
    latitude: 40.844434,
    longitude: -73.914685,
    lines: ['4'],
    childPlatforms: ['411N', '411S']
  },
  {
    id: '412',
    name: '170 St',
    city: 'nyc',
    latitude: 40.840075,
    longitude: -73.917791,
    lines: ['4'],
    childPlatforms: ['412N', '412S']
  },
  {
    id: '413',
    name: '167 St',
    city: 'nyc',
    latitude: 40.835537,
    longitude: -73.9214,
    lines: ['4'],
    childPlatforms: ['413N', '413S']
  },
  {
    id: '414',
    name: '161 St-Yankee Stadium',
    city: 'nyc',
    latitude: 40.827994,
    longitude: -73.925831,
    lines: ['4'],
    childPlatforms: ['414N', '414S'],
    transfers: [
      { toStationId: 'D11', toStationName: '161 St-Yankee Stadium', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '415',
    name: '149 St-Grand Concourse',
    city: 'nyc',
    latitude: 40.818375,
    longitude: -73.927351,
    lines: ['4'],
    childPlatforms: ['415N', '415S'],
    transfers: [
      { toStationId: '222', toStationName: '149 St-Grand Concourse', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '416',
    name: '138 St-Grand Concourse',
    city: 'nyc',
    latitude: 40.813224,
    longitude: -73.929849,
    lines: ['4', '5'],
    childPlatforms: ['416N', '416S']
  },
  {
    id: '418',
    name: 'Fulton St',
    city: 'nyc',
    latitude: 40.710368,
    longitude: -74.009509,
    lines: ['4', '5'],
    childPlatforms: ['418N', '418S'],
    transfers: [
      { toStationId: 'A38', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '229', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'M22', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '419',
    name: 'Wall St',
    city: 'nyc',
    latitude: 40.707557,
    longitude: -74.011862,
    lines: ['4', '5'],
    childPlatforms: ['419N', '419S']
  },
  {
    id: '420',
    name: 'Bowling Green',
    city: 'nyc',
    latitude: 40.704817,
    longitude: -74.014065,
    lines: ['4', '5'],
    childPlatforms: ['420N', '420S']
  },
  {
    id: '423',
    name: 'Borough Hall',
    city: 'nyc',
    latitude: 40.692404,
    longitude: -73.990151,
    lines: ['4', '5'],
    childPlatforms: ['423N', '423S'],
    transfers: [
      { toStationId: 'R28', toStationName: 'Court St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '232', toStationName: 'Borough Hall', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '501',
    name: 'Eastchester-Dyre Av',
    city: 'nyc',
    latitude: 40.8883,
    longitude: -73.830834,
    lines: ['5'],
    childPlatforms: ['501N', '501S']
  },
  {
    id: '502',
    name: 'Baychester Av',
    city: 'nyc',
    latitude: 40.878663,
    longitude: -73.838591,
    lines: ['5'],
    childPlatforms: ['502N', '502S']
  },
  {
    id: '503',
    name: 'Gun Hill Rd',
    city: 'nyc',
    latitude: 40.869526,
    longitude: -73.846384,
    lines: ['5'],
    childPlatforms: ['503N', '503S']
  },
  {
    id: '504',
    name: 'Pelham Pkwy',
    city: 'nyc',
    latitude: 40.858985,
    longitude: -73.855359,
    lines: ['5'],
    childPlatforms: ['504N', '504S']
  },
  {
    id: '505',
    name: 'Morris Park',
    city: 'nyc',
    latitude: 40.854364,
    longitude: -73.860495,
    lines: ['5'],
    childPlatforms: ['505N', '505S']
  },
  {
    id: '601',
    name: 'Pelham Bay Park',
    city: 'nyc',
    latitude: 40.852462,
    longitude: -73.828121,
    lines: ['6', '6X'],
    childPlatforms: ['601N', '601S']
  },
  {
    id: '602',
    name: 'Buhre Av',
    city: 'nyc',
    latitude: 40.84681,
    longitude: -73.832569,
    lines: ['6', '6X'],
    childPlatforms: ['602N', '602S']
  },
  {
    id: '603',
    name: 'Middletown Rd',
    city: 'nyc',
    latitude: 40.843863,
    longitude: -73.836322,
    lines: ['6', '6X'],
    childPlatforms: ['603N', '603S']
  },
  {
    id: '604',
    name: 'Westchester Sq-E Tremont Av',
    city: 'nyc',
    latitude: 40.839892,
    longitude: -73.842952,
    lines: ['6', '6X'],
    childPlatforms: ['604N', '604S']
  },
  {
    id: '606',
    name: 'Zerega Av',
    city: 'nyc',
    latitude: 40.836488,
    longitude: -73.847036,
    lines: ['6', '6X'],
    childPlatforms: ['606N', '606S']
  },
  {
    id: '607',
    name: 'Castle Hill Av',
    city: 'nyc',
    latitude: 40.834255,
    longitude: -73.851222,
    lines: ['6', '6X'],
    childPlatforms: ['607N', '607S']
  },
  {
    id: '608',
    name: 'Parkchester',
    city: 'nyc',
    latitude: 40.833226,
    longitude: -73.860816,
    lines: ['6', '6X'],
    childPlatforms: ['608N', '608S']
  },
  {
    id: '609',
    name: 'St Lawrence Av',
    city: 'nyc',
    latitude: 40.831509,
    longitude: -73.867618,
    lines: ['6'],
    childPlatforms: ['609N', '609S']
  },
  {
    id: '610',
    name: 'Morrison Av-Soundview',
    city: 'nyc',
    latitude: 40.829521,
    longitude: -73.874516,
    lines: ['6'],
    childPlatforms: ['610N', '610S']
  },
  {
    id: '611',
    name: 'Elder Av',
    city: 'nyc',
    latitude: 40.828584,
    longitude: -73.879159,
    lines: ['6'],
    childPlatforms: ['611N', '611S']
  },
  {
    id: '612',
    name: 'Whitlock Av',
    city: 'nyc',
    latitude: 40.826525,
    longitude: -73.886283,
    lines: ['6'],
    childPlatforms: ['612N', '612S']
  },
  {
    id: '613',
    name: 'Hunts Point Av',
    city: 'nyc',
    latitude: 40.820948,
    longitude: -73.890549,
    lines: ['6', '6X'],
    childPlatforms: ['613N', '613S']
  },
  {
    id: '614',
    name: 'Longwood Av',
    city: 'nyc',
    latitude: 40.816104,
    longitude: -73.896435,
    lines: ['6'],
    childPlatforms: ['614N', '614S']
  },
  {
    id: '615',
    name: 'E 149 St',
    city: 'nyc',
    latitude: 40.812118,
    longitude: -73.904098,
    lines: ['6'],
    childPlatforms: ['615N', '615S']
  },
  {
    id: '616',
    name: 'E 143 St-St Mary\'s St',
    city: 'nyc',
    latitude: 40.808719,
    longitude: -73.907657,
    lines: ['6'],
    childPlatforms: ['616N', '616S']
  },
  {
    id: '617',
    name: 'Cypress Av',
    city: 'nyc',
    latitude: 40.805368,
    longitude: -73.914042,
    lines: ['6'],
    childPlatforms: ['617N', '617S']
  },
  {
    id: '618',
    name: 'Brook Av',
    city: 'nyc',
    latitude: 40.807566,
    longitude: -73.91924,
    lines: ['6'],
    childPlatforms: ['618N', '618S']
  },
  {
    id: '619',
    name: '3 Av-138 St',
    city: 'nyc',
    latitude: 40.810476,
    longitude: -73.926138,
    lines: ['6', '6X'],
    childPlatforms: ['619N', '619S']
  },
  {
    id: '621',
    name: '125 St',
    city: 'nyc',
    latitude: 40.804138,
    longitude: -73.937594,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['621N', '621S']
  },
  {
    id: '622',
    name: '116 St',
    city: 'nyc',
    latitude: 40.798629,
    longitude: -73.941617,
    lines: ['4', '6', '6X'],
    childPlatforms: ['622N', '622S']
  },
  {
    id: '623',
    name: '110 St',
    city: 'nyc',
    latitude: 40.79502,
    longitude: -73.94425,
    lines: ['4', '6', '6X'],
    childPlatforms: ['623N', '623S']
  },
  {
    id: '624',
    name: '103 St',
    city: 'nyc',
    latitude: 40.7906,
    longitude: -73.947478,
    lines: ['4', '6', '6X'],
    childPlatforms: ['624N', '624S']
  },
  {
    id: '625',
    name: '96 St',
    city: 'nyc',
    latitude: 40.785672,
    longitude: -73.95107,
    lines: ['4', '6', '6X'],
    childPlatforms: ['625N', '625S']
  },
  {
    id: '626',
    name: '86 St',
    city: 'nyc',
    latitude: 40.779492,
    longitude: -73.955589,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['626N', '626S']
  },
  {
    id: '627',
    name: '77 St',
    city: 'nyc',
    latitude: 40.77362,
    longitude: -73.959874,
    lines: ['4', '6', '6X'],
    childPlatforms: ['627N', '627S']
  },
  {
    id: '628',
    name: '68 St-Hunter College',
    city: 'nyc',
    latitude: 40.768141,
    longitude: -73.96387,
    lines: ['4', '6', '6X'],
    childPlatforms: ['628N', '628S']
  },
  {
    id: '629',
    name: '59 St',
    city: 'nyc',
    latitude: 40.762526,
    longitude: -73.967967,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['629N', '629S'],
    transfers: [
      { toStationId: 'R11', toStationName: 'Lexington Av/59 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'B08', toStationName: 'Lexington Av/63 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '630',
    name: '51 St',
    city: 'nyc',
    latitude: 40.757107,
    longitude: -73.97192,
    lines: ['4', '6', '6X'],
    childPlatforms: ['630N', '630S'],
    transfers: [
      { toStationId: 'F11', toStationName: 'Lexington Av/53 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '631',
    name: 'Grand Central-42 St',
    city: 'nyc',
    latitude: 40.751776,
    longitude: -73.976848,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['631N', '631S'],
    transfers: [
      { toStationId: '723', toStationName: 'Grand Central-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '901', toStationName: 'Grand Central-42 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '632',
    name: '33 St',
    city: 'nyc',
    latitude: 40.746081,
    longitude: -73.982076,
    lines: ['4', '6', '6X'],
    childPlatforms: ['632N', '632S']
  },
  {
    id: '633',
    name: '28 St',
    city: 'nyc',
    latitude: 40.74307,
    longitude: -73.984264,
    lines: ['4', '6', '6X'],
    childPlatforms: ['633N', '633S']
  },
  {
    id: '634',
    name: '23 St-Baruch College',
    city: 'nyc',
    latitude: 40.739864,
    longitude: -73.986599,
    lines: ['4', '6', '6X'],
    childPlatforms: ['634N', '634S']
  },
  {
    id: '635',
    name: '14 St-Union Sq',
    city: 'nyc',
    latitude: 40.734673,
    longitude: -73.989951,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['635N', '635S'],
    transfers: [
      { toStationId: 'L03', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R20', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '636',
    name: 'Astor Pl',
    city: 'nyc',
    latitude: 40.730054,
    longitude: -73.99107,
    lines: ['4', '6', '6X'],
    childPlatforms: ['636N', '636S']
  },
  {
    id: '637',
    name: 'Bleecker St',
    city: 'nyc',
    latitude: 40.725915,
    longitude: -73.994659,
    lines: ['4', '6', '6X'],
    childPlatforms: ['637N', '637S'],
    transfers: [
      { toStationId: 'D21', toStationName: 'Broadway-Lafayette St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '638',
    name: 'Spring St',
    city: 'nyc',
    latitude: 40.722301,
    longitude: -73.997141,
    lines: ['4', '6', '6X'],
    childPlatforms: ['638N', '638S']
  },
  {
    id: '639',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.718803,
    longitude: -74.000193,
    lines: ['4', '6', '6X'],
    childPlatforms: ['639N', '639S'],
    transfers: [
      { toStationId: 'M20', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'Q01', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R23', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '640',
    name: 'Brooklyn Bridge-City Hall',
    city: 'nyc',
    latitude: 40.713065,
    longitude: -74.004131,
    lines: ['4', '5', '6', '6X'],
    childPlatforms: ['640N', '640S'],
    transfers: [
      { toStationId: 'M21', toStationName: 'Chambers St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '701',
    name: 'Flushing-Main St',
    city: 'nyc',
    latitude: 40.7596,
    longitude: -73.83003,
    lines: ['7', '7X'],
    childPlatforms: ['701N', '701S']
  },
  {
    id: '702',
    name: 'Mets-Willets Point',
    city: 'nyc',
    latitude: 40.754622,
    longitude: -73.845625,
    lines: ['7', '7X'],
    childPlatforms: ['702N', '702S']
  },
  {
    id: '705',
    name: '111 St',
    city: 'nyc',
    latitude: 40.75173,
    longitude: -73.855334,
    lines: ['7'],
    childPlatforms: ['705N', '705S']
  },
  {
    id: '706',
    name: '103 St-Corona Plaza',
    city: 'nyc',
    latitude: 40.749865,
    longitude: -73.8627,
    lines: ['7'],
    childPlatforms: ['706N', '706S']
  },
  {
    id: '707',
    name: 'Junction Blvd',
    city: 'nyc',
    latitude: 40.749145,
    longitude: -73.869527,
    lines: ['7', '7X'],
    childPlatforms: ['707N', '707S']
  },
  {
    id: '708',
    name: '90 St-Elmhurst Av',
    city: 'nyc',
    latitude: 40.748408,
    longitude: -73.876613,
    lines: ['7'],
    childPlatforms: ['708N', '708S']
  },
  {
    id: '709',
    name: '82 St-Jackson Hts',
    city: 'nyc',
    latitude: 40.747659,
    longitude: -73.883697,
    lines: ['7'],
    childPlatforms: ['709N', '709S']
  },
  {
    id: '710',
    name: '74 St-Broadway',
    city: 'nyc',
    latitude: 40.746848,
    longitude: -73.891394,
    lines: ['7', '7X'],
    childPlatforms: ['710N', '710S'],
    transfers: [
      { toStationId: 'G14', toStationName: 'Jackson Hts-Roosevelt Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '711',
    name: '69 St',
    city: 'nyc',
    latitude: 40.746325,
    longitude: -73.896403,
    lines: ['7', '7X'],
    childPlatforms: ['711N', '711S']
  },
  {
    id: '712',
    name: '61 St-Woodside',
    city: 'nyc',
    latitude: 40.74563,
    longitude: -73.902984,
    lines: ['7', '7X'],
    childPlatforms: ['712N', '712S']
  },
  {
    id: '713',
    name: '52 St',
    city: 'nyc',
    latitude: 40.744149,
    longitude: -73.912549,
    lines: ['7', '7X'],
    childPlatforms: ['713N', '713S']
  },
  {
    id: '714',
    name: '46 St-Bliss St',
    city: 'nyc',
    latitude: 40.743132,
    longitude: -73.918435,
    lines: ['7', '7X'],
    childPlatforms: ['714N', '714S']
  },
  {
    id: '715',
    name: '40 St-Lowery St',
    city: 'nyc',
    latitude: 40.743781,
    longitude: -73.924016,
    lines: ['7', '7X'],
    childPlatforms: ['715N', '715S']
  },
  {
    id: '716',
    name: '33 St-Rawson St',
    city: 'nyc',
    latitude: 40.744587,
    longitude: -73.930997,
    lines: ['7', '7X'],
    childPlatforms: ['716N', '716S']
  },
  {
    id: '718',
    name: 'Queensboro Plaza',
    city: 'nyc',
    latitude: 40.750582,
    longitude: -73.940202,
    lines: ['7', '7X'],
    childPlatforms: ['718N', '718S'],
    transfers: [
      { toStationId: 'R09', toStationName: 'Queensboro Plaza', transferTime: 0, transferType: 'nearby' }
    ]
  },
  {
    id: '719',
    name: 'Court Sq',
    city: 'nyc',
    latitude: 40.747023,
    longitude: -73.945264,
    lines: ['7', '7X'],
    childPlatforms: ['719N', '719S'],
    transfers: [
      { toStationId: 'G22', toStationName: 'Court Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'F09', toStationName: 'Court Sq-23 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '720',
    name: 'Hunters Point Av',
    city: 'nyc',
    latitude: 40.742216,
    longitude: -73.948916,
    lines: ['7', '7X'],
    childPlatforms: ['720N', '720S']
  },
  {
    id: '721',
    name: 'Vernon Blvd-Jackson Av',
    city: 'nyc',
    latitude: 40.742626,
    longitude: -73.953581,
    lines: ['7', '7X'],
    childPlatforms: ['721N', '721S']
  },
  {
    id: '723',
    name: 'Grand Central-42 St',
    city: 'nyc',
    latitude: 40.751431,
    longitude: -73.976041,
    lines: ['7', '7X'],
    childPlatforms: ['723N', '723S'],
    transfers: [
      { toStationId: '631', toStationName: 'Grand Central-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '901', toStationName: 'Grand Central-42 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '724',
    name: '5 Av',
    city: 'nyc',
    latitude: 40.753821,
    longitude: -73.981963,
    lines: ['7', '7X'],
    childPlatforms: ['724N', '724S'],
    transfers: [
      { toStationId: 'D16', toStationName: '42 St-Bryant Pk', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: '725',
    name: 'Times Sq-42 St',
    city: 'nyc',
    latitude: 40.755477,
    longitude: -73.987691,
    lines: ['7', '7X'],
    childPlatforms: ['725N', '725S'],
    transfers: [
      { toStationId: '127', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'A27', toStationName: '42 St-Port Authority Bus Terminal', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R16', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '902', toStationName: 'Times Sq-42 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '726',
    name: '34 St-Hudson Yards',
    city: 'nyc',
    latitude: 40.755882,
    longitude: -74.00191,
    lines: ['7', '7X'],
    childPlatforms: ['726N', '726S']
  },
  {
    id: '901',
    name: 'Grand Central-42 St',
    city: 'nyc',
    latitude: 40.752769,
    longitude: -73.979189,
    lines: ['S'],
    childPlatforms: ['901N', '901S'],
    transfers: [
      { toStationId: '631', toStationName: 'Grand Central-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '723', toStationName: 'Grand Central-42 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: '902',
    name: 'Times Sq-42 St',
    city: 'nyc',
    latitude: 40.755983,
    longitude: -73.986229,
    lines: ['S'],
    childPlatforms: ['902N', '902S'],
    transfers: [
      { toStationId: '127', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R16', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '725', toStationName: 'Times Sq-42 St', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'A27', toStationName: '42 St-Port Authority Bus Terminal', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'A02',
    name: 'Inwood-207 St',
    city: 'nyc',
    latitude: 40.868072,
    longitude: -73.919899,
    lines: ['A'],
    childPlatforms: ['A02N', 'A02S']
  },
  {
    id: 'A03',
    name: 'Dyckman St',
    city: 'nyc',
    latitude: 40.865491,
    longitude: -73.927271,
    lines: ['A'],
    childPlatforms: ['A03N', 'A03S']
  },
  {
    id: 'A05',
    name: '190 St',
    city: 'nyc',
    latitude: 40.859022,
    longitude: -73.93418,
    lines: ['A'],
    childPlatforms: ['A05N', 'A05S']
  },
  {
    id: 'A06',
    name: '181 St',
    city: 'nyc',
    latitude: 40.851695,
    longitude: -73.937969,
    lines: ['A'],
    childPlatforms: ['A06N', 'A06S']
  },
  {
    id: 'A07',
    name: '175 St',
    city: 'nyc',
    latitude: 40.847391,
    longitude: -73.939704,
    lines: ['A'],
    childPlatforms: ['A07N', 'A07S']
  },
  {
    id: 'A09',
    name: '168 St',
    city: 'nyc',
    latitude: 40.840719,
    longitude: -73.939561,
    lines: ['A', 'C'],
    childPlatforms: ['A09N', 'A09S'],
    transfers: [
      { toStationId: '112', toStationName: '168 St-Washington Hts', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A10',
    name: '163 St-Amsterdam Av',
    city: 'nyc',
    latitude: 40.836013,
    longitude: -73.939892,
    lines: ['A', 'C'],
    childPlatforms: ['A10N', 'A10S']
  },
  {
    id: 'A11',
    name: '155 St',
    city: 'nyc',
    latitude: 40.830518,
    longitude: -73.941514,
    lines: ['A', 'C'],
    childPlatforms: ['A11N', 'A11S']
  },
  {
    id: 'A12',
    name: '145 St',
    city: 'nyc',
    latitude: 40.824783,
    longitude: -73.944216,
    lines: ['A', 'C'],
    childPlatforms: ['A12N', 'A12S'],
    transfers: [
      { toStationId: 'D13', toStationName: '145 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A14',
    name: '135 St',
    city: 'nyc',
    latitude: 40.817894,
    longitude: -73.947649,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A14N', 'A14S']
  },
  {
    id: 'A15',
    name: '125 St',
    city: 'nyc',
    latitude: 40.811109,
    longitude: -73.952343,
    lines: ['A', 'B', 'C', 'D'],
    childPlatforms: ['A15N', 'A15S']
  },
  {
    id: 'A16',
    name: '116 St',
    city: 'nyc',
    latitude: 40.805085,
    longitude: -73.954882,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A16N', 'A16S']
  },
  {
    id: 'A17',
    name: 'Cathedral Pkwy (110 St)',
    city: 'nyc',
    latitude: 40.800603,
    longitude: -73.958161,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A17N', 'A17S']
  },
  {
    id: 'A18',
    name: '103 St',
    city: 'nyc',
    latitude: 40.796092,
    longitude: -73.961454,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A18N', 'A18S']
  },
  {
    id: 'A19',
    name: '96 St',
    city: 'nyc',
    latitude: 40.791642,
    longitude: -73.964696,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A19N', 'A19S']
  },
  {
    id: 'A20',
    name: '86 St',
    city: 'nyc',
    latitude: 40.785868,
    longitude: -73.968916,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A20N', 'A20S']
  },
  {
    id: 'A21',
    name: '81 St-Museum of Natural History',
    city: 'nyc',
    latitude: 40.781433,
    longitude: -73.972143,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A21N', 'A21S']
  },
  {
    id: 'A22',
    name: '72 St',
    city: 'nyc',
    latitude: 40.775594,
    longitude: -73.97641,
    lines: ['A', 'B', 'C'],
    childPlatforms: ['A22N', 'A22S']
  },
  {
    id: 'A24',
    name: '59 St-Columbus Circle',
    city: 'nyc',
    latitude: 40.768296,
    longitude: -73.981736,
    lines: ['A', 'B', 'C', 'D'],
    childPlatforms: ['A24N', 'A24S'],
    transfers: [
      { toStationId: '125', toStationName: '59 St-Columbus Circle', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A25',
    name: '50 St',
    city: 'nyc',
    latitude: 40.762456,
    longitude: -73.985984,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A25N', 'A25S']
  },
  {
    id: 'A27',
    name: '42 St-Port Authority Bus Terminal',
    city: 'nyc',
    latitude: 40.757308,
    longitude: -73.989735,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A27N', 'A27S'],
    transfers: [
      { toStationId: '725', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '127', toStationName: 'Times Sq-42 St', transferTime: 300, transferType: 'nearby' },
      { toStationId: '902', toStationName: 'Times Sq-42 St', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'R16', toStationName: 'Times Sq-42 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'A28',
    name: '34 St-Penn Station',
    city: 'nyc',
    latitude: 40.752287,
    longitude: -73.993391,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A28N', 'A28S']
  },
  {
    id: 'A30',
    name: '23 St',
    city: 'nyc',
    latitude: 40.745906,
    longitude: -73.998041,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A30N', 'A30S']
  },
  {
    id: 'A31',
    name: '14 St',
    city: 'nyc',
    latitude: 40.740893,
    longitude: -74.00169,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A31N', 'A31S'],
    transfers: [
      { toStationId: 'L01', toStationName: '8 Av', transferTime: 90, transferType: 'nearby' }
    ]
  },
  {
    id: 'A32',
    name: 'W 4 St-Wash Sq',
    city: 'nyc',
    latitude: 40.732338,
    longitude: -74.000495,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A32N', 'A32S'],
    transfers: [
      { toStationId: 'D20', toStationName: 'W 4 St-Wash Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A33',
    name: 'Spring St',
    city: 'nyc',
    latitude: 40.726227,
    longitude: -74.003739,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A33N', 'A33S']
  },
  {
    id: 'A34',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.720824,
    longitude: -74.005229,
    lines: ['A', 'C', 'E'],
    childPlatforms: ['A34N', 'A34S']
  },
  {
    id: 'A36',
    name: 'Chambers St',
    city: 'nyc',
    latitude: 40.714111,
    longitude: -74.008585,
    lines: ['A', 'C'],
    childPlatforms: ['A36N', 'A36S'],
    transfers: [
      { toStationId: '228', toStationName: 'Park Place', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'E01', toStationName: 'World Trade Center', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'R25', toStationName: 'Cortlandt St', transferTime: 420, transferType: 'nearby' }
    ]
  },
  {
    id: 'A38',
    name: 'Fulton St',
    city: 'nyc',
    latitude: 40.710197,
    longitude: -74.007691,
    lines: ['A', 'C'],
    childPlatforms: ['A38N', 'A38S'],
    transfers: [
      { toStationId: '229', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '418', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'M22', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A40',
    name: 'High St',
    city: 'nyc',
    latitude: 40.699337,
    longitude: -73.990531,
    lines: ['A', 'C'],
    childPlatforms: ['A40N', 'A40S']
  },
  {
    id: 'A41',
    name: 'Jay St-MetroTech',
    city: 'nyc',
    latitude: 40.692338,
    longitude: -73.987342,
    lines: ['A', 'C', 'F', 'FX'],
    childPlatforms: ['A41N', 'A41S'],
    transfers: [
      { toStationId: 'R29', toStationName: 'Jay St-MetroTech', transferTime: 90, transferType: 'nearby' }
    ]
  },
  {
    id: 'A42',
    name: 'Hoyt-Schermerhorn Sts',
    city: 'nyc',
    latitude: 40.688484,
    longitude: -73.985001,
    lines: ['A', 'C', 'G'],
    childPlatforms: ['A42N', 'A42S']
  },
  {
    id: 'A43',
    name: 'Lafayette Av',
    city: 'nyc',
    latitude: 40.686113,
    longitude: -73.973946,
    lines: ['A', 'C'],
    childPlatforms: ['A43N', 'A43S']
  },
  {
    id: 'A44',
    name: 'Clinton-Washington Avs',
    city: 'nyc',
    latitude: 40.683263,
    longitude: -73.965838,
    lines: ['A', 'C'],
    childPlatforms: ['A44N', 'A44S']
  },
  {
    id: 'A45',
    name: 'Franklin Av',
    city: 'nyc',
    latitude: 40.68138,
    longitude: -73.956848,
    lines: ['A', 'C'],
    childPlatforms: ['A45N', 'A45S'],
    transfers: [
      { toStationId: 'S01', toStationName: 'Franklin Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A46',
    name: 'Nostrand Av',
    city: 'nyc',
    latitude: 40.680438,
    longitude: -73.950426,
    lines: ['A', 'C'],
    childPlatforms: ['A46N', 'A46S']
  },
  {
    id: 'A47',
    name: 'Kingston-Throop Avs',
    city: 'nyc',
    latitude: 40.679921,
    longitude: -73.940858,
    lines: ['A', 'C'],
    childPlatforms: ['A47N', 'A47S']
  },
  {
    id: 'A48',
    name: 'Utica Av',
    city: 'nyc',
    latitude: 40.679364,
    longitude: -73.930729,
    lines: ['A', 'C'],
    childPlatforms: ['A48N', 'A48S']
  },
  {
    id: 'A49',
    name: 'Ralph Av',
    city: 'nyc',
    latitude: 40.678822,
    longitude: -73.920786,
    lines: ['A', 'C'],
    childPlatforms: ['A49N', 'A49S']
  },
  {
    id: 'A50',
    name: 'Rockaway Av',
    city: 'nyc',
    latitude: 40.67834,
    longitude: -73.911946,
    lines: ['A', 'C'],
    childPlatforms: ['A50N', 'A50S']
  },
  {
    id: 'A51',
    name: 'Broadway Junction',
    city: 'nyc',
    latitude: 40.678334,
    longitude: -73.905316,
    lines: ['A', 'C'],
    childPlatforms: ['A51N', 'A51S'],
    transfers: [
      { toStationId: 'J27', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'L22', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'A52',
    name: 'Liberty Av',
    city: 'nyc',
    latitude: 40.674542,
    longitude: -73.896548,
    lines: ['A', 'C'],
    childPlatforms: ['A52N', 'A52S']
  },
  {
    id: 'A53',
    name: 'Van Siclen Av',
    city: 'nyc',
    latitude: 40.67271,
    longitude: -73.890358,
    lines: ['A', 'C'],
    childPlatforms: ['A53N', 'A53S']
  },
  {
    id: 'A54',
    name: 'Shepherd Av',
    city: 'nyc',
    latitude: 40.67413,
    longitude: -73.88075,
    lines: ['A', 'C'],
    childPlatforms: ['A54N', 'A54S']
  },
  {
    id: 'A55',
    name: 'Euclid Av',
    city: 'nyc',
    latitude: 40.675377,
    longitude: -73.872106,
    lines: ['A', 'C'],
    childPlatforms: ['A55N', 'A55S']
  },
  {
    id: 'A57',
    name: 'Grant Av',
    city: 'nyc',
    latitude: 40.677044,
    longitude: -73.86505,
    lines: ['A'],
    childPlatforms: ['A57N', 'A57S']
  },
  {
    id: 'A59',
    name: '80 St',
    city: 'nyc',
    latitude: 40.679371,
    longitude: -73.858992,
    lines: ['A'],
    childPlatforms: ['A59N', 'A59S']
  },
  {
    id: 'A60',
    name: '88 St',
    city: 'nyc',
    latitude: 40.679843,
    longitude: -73.85147,
    lines: ['A'],
    childPlatforms: ['A60N', 'A60S']
  },
  {
    id: 'A61',
    name: 'Rockaway Blvd',
    city: 'nyc',
    latitude: 40.680429,
    longitude: -73.843853,
    lines: ['A'],
    childPlatforms: ['A61N', 'A61S']
  },
  {
    id: 'A63',
    name: '104 St',
    city: 'nyc',
    latitude: 40.681711,
    longitude: -73.837683,
    lines: ['A'],
    childPlatforms: ['A63N', 'A63S']
  },
  {
    id: 'A64',
    name: '111 St',
    city: 'nyc',
    latitude: 40.684331,
    longitude: -73.832163,
    lines: ['A'],
    childPlatforms: ['A64N', 'A64S']
  },
  {
    id: 'A65',
    name: 'Ozone Park-Lefferts Blvd',
    city: 'nyc',
    latitude: 40.685951,
    longitude: -73.825798,
    lines: ['A'],
    childPlatforms: ['A65N', 'A65S']
  },
  {
    id: 'B04',
    name: '21 St-Queensbridge',
    city: 'nyc',
    latitude: 40.754203,
    longitude: -73.942836,
    lines: ['F', 'M'],
    childPlatforms: ['B04N', 'B04S']
  },
  {
    id: 'B06',
    name: 'Roosevelt Island',
    city: 'nyc',
    latitude: 40.759145,
    longitude: -73.95326,
    lines: ['F', 'M'],
    childPlatforms: ['B06N', 'B06S']
  },
  {
    id: 'B08',
    name: 'Lexington Av/63 St',
    city: 'nyc',
    latitude: 40.764629,
    longitude: -73.966113,
    lines: ['F', 'M', 'N', 'Q', 'R'],
    childPlatforms: ['B08N', 'B08S'],
    transfers: [
      { toStationId: '629', toStationName: '59 St', transferTime: 300, transferType: 'nearby' },
      { toStationId: 'R11', toStationName: 'Lexington Av/59 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'B10',
    name: '57 St',
    city: 'nyc',
    latitude: 40.763972,
    longitude: -73.97745,
    lines: ['F', 'M'],
    childPlatforms: ['B10N', 'B10S']
  },
  {
    id: 'B12',
    name: '9 Av',
    city: 'nyc',
    latitude: 40.646292,
    longitude: -73.994324,
    lines: ['D', 'R', 'W'],
    childPlatforms: ['B12N', 'B12S']
  },
  {
    id: 'B13',
    name: 'Fort Hamilton Pkwy',
    city: 'nyc',
    latitude: 40.640914,
    longitude: -73.994304,
    lines: ['D'],
    childPlatforms: ['B13N', 'B13S']
  },
  {
    id: 'B14',
    name: '50 St',
    city: 'nyc',
    latitude: 40.63626,
    longitude: -73.994791,
    lines: ['D'],
    childPlatforms: ['B14N', 'B14S']
  },
  {
    id: 'B15',
    name: '55 St',
    city: 'nyc',
    latitude: 40.631435,
    longitude: -73.995476,
    lines: ['D'],
    childPlatforms: ['B15N', 'B15S']
  },
  {
    id: 'B16',
    name: '62 St',
    city: 'nyc',
    latitude: 40.626472,
    longitude: -73.996895,
    lines: ['D', 'R', 'W'],
    childPlatforms: ['B16N', 'B16S'],
    transfers: [
      { toStationId: 'N04', toStationName: 'New Utrecht Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'B17',
    name: '71 St',
    city: 'nyc',
    latitude: 40.619589,
    longitude: -73.998864,
    lines: ['D'],
    childPlatforms: ['B17N', 'B17S']
  },
  {
    id: 'B18',
    name: '79 St',
    city: 'nyc',
    latitude: 40.613501,
    longitude: -74.00061,
    lines: ['D'],
    childPlatforms: ['B18N', 'B18S']
  },
  {
    id: 'B19',
    name: '18 Av',
    city: 'nyc',
    latitude: 40.607954,
    longitude: -74.001736,
    lines: ['D'],
    childPlatforms: ['B19N', 'B19S']
  },
  {
    id: 'B20',
    name: '20 Av',
    city: 'nyc',
    latitude: 40.604556,
    longitude: -73.998168,
    lines: ['D'],
    childPlatforms: ['B20N', 'B20S']
  },
  {
    id: 'B21',
    name: 'Bay Pkwy',
    city: 'nyc',
    latitude: 40.601875,
    longitude: -73.993728,
    lines: ['D', 'R', 'W'],
    childPlatforms: ['B21N', 'B21S']
  },
  {
    id: 'B22',
    name: '25 Av',
    city: 'nyc',
    latitude: 40.597704,
    longitude: -73.986829,
    lines: ['D'],
    childPlatforms: ['B22N', 'B22S']
  },
  {
    id: 'B23',
    name: 'Bay 50 St',
    city: 'nyc',
    latitude: 40.588841,
    longitude: -73.983765,
    lines: ['D'],
    childPlatforms: ['B23N', 'B23S']
  },
  {
    id: 'D01',
    name: 'Norwood-205 St',
    city: 'nyc',
    latitude: 40.874811,
    longitude: -73.878855,
    lines: ['D'],
    childPlatforms: ['D01N', 'D01S']
  },
  {
    id: 'D03',
    name: 'Bedford Park Blvd',
    city: 'nyc',
    latitude: 40.873244,
    longitude: -73.887138,
    lines: ['B', 'D'],
    childPlatforms: ['D03N', 'D03S']
  },
  {
    id: 'D04',
    name: 'Kingsbridge Rd',
    city: 'nyc',
    latitude: 40.866978,
    longitude: -73.893509,
    lines: ['B', 'D'],
    childPlatforms: ['D04N', 'D04S']
  },
  {
    id: 'D05',
    name: 'Fordham Rd',
    city: 'nyc',
    latitude: 40.861296,
    longitude: -73.897749,
    lines: ['B', 'D'],
    childPlatforms: ['D05N', 'D05S']
  },
  {
    id: 'D06',
    name: '182-183 Sts',
    city: 'nyc',
    latitude: 40.856093,
    longitude: -73.900741,
    lines: ['B', 'D'],
    childPlatforms: ['D06N', 'D06S']
  },
  {
    id: 'D07',
    name: 'Tremont Av',
    city: 'nyc',
    latitude: 40.85041,
    longitude: -73.905227,
    lines: ['B', 'D'],
    childPlatforms: ['D07N', 'D07S']
  },
  {
    id: 'D08',
    name: '174-175 Sts',
    city: 'nyc',
    latitude: 40.8459,
    longitude: -73.910136,
    lines: ['B', 'D'],
    childPlatforms: ['D08N', 'D08S']
  },
  {
    id: 'D09',
    name: '170 St',
    city: 'nyc',
    latitude: 40.839306,
    longitude: -73.9134,
    lines: ['B', 'D'],
    childPlatforms: ['D09N', 'D09S']
  },
  {
    id: 'D10',
    name: '167 St',
    city: 'nyc',
    latitude: 40.833771,
    longitude: -73.91844,
    lines: ['B', 'D'],
    childPlatforms: ['D10N', 'D10S']
  },
  {
    id: 'D11',
    name: '161 St-Yankee Stadium',
    city: 'nyc',
    latitude: 40.827905,
    longitude: -73.925651,
    lines: ['B', 'D'],
    childPlatforms: ['D11N', 'D11S'],
    transfers: [
      { toStationId: '414', toStationName: '161 St-Yankee Stadium', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D12',
    name: '155 St',
    city: 'nyc',
    latitude: 40.830135,
    longitude: -73.938209,
    lines: ['B', 'D'],
    childPlatforms: ['D12N', 'D12S']
  },
  {
    id: 'D13',
    name: '145 St',
    city: 'nyc',
    latitude: 40.824783,
    longitude: -73.944216,
    lines: ['B', 'D'],
    childPlatforms: ['D13N', 'D13S'],
    transfers: [
      { toStationId: 'A12', toStationName: '145 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D14',
    name: '7 Av',
    city: 'nyc',
    latitude: 40.762862,
    longitude: -73.981637,
    lines: ['B', 'D', 'E'],
    childPlatforms: ['D14N', 'D14S']
  },
  {
    id: 'D15',
    name: '47-50 Sts-Rockefeller Ctr',
    city: 'nyc',
    latitude: 40.758663,
    longitude: -73.981329,
    lines: ['B', 'D', 'F', 'FX', 'M'],
    childPlatforms: ['D15N', 'D15S']
  },
  {
    id: 'D16',
    name: '42 St-Bryant Pk',
    city: 'nyc',
    latitude: 40.754222,
    longitude: -73.984569,
    lines: ['B', 'D', 'F', 'FX', 'M'],
    childPlatforms: ['D16N', 'D16S'],
    transfers: [
      { toStationId: '724', toStationName: '5 Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D17',
    name: '34 St-Herald Sq',
    city: 'nyc',
    latitude: 40.749719,
    longitude: -73.987823,
    lines: ['B', 'D', 'F', 'FX', 'M'],
    childPlatforms: ['D17N', 'D17S'],
    transfers: [
      { toStationId: 'R17', toStationName: '34 St-Herald Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D18',
    name: '23 St',
    city: 'nyc',
    latitude: 40.742878,
    longitude: -73.992821,
    lines: ['F', 'FX', 'M'],
    childPlatforms: ['D18N', 'D18S']
  },
  {
    id: 'D19',
    name: '14 St',
    city: 'nyc',
    latitude: 40.738228,
    longitude: -73.996209,
    lines: ['F', 'FX', 'M'],
    childPlatforms: ['D19N', 'D19S'],
    transfers: [
      { toStationId: 'L02', toStationName: '6 Av', transferTime: 180, transferType: 'nearby' },
      { toStationId: '132', toStationName: '14 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'D20',
    name: 'W 4 St-Wash Sq',
    city: 'nyc',
    latitude: 40.732338,
    longitude: -74.000495,
    lines: ['B', 'D', 'F', 'FX', 'M'],
    childPlatforms: ['D20N', 'D20S'],
    transfers: [
      { toStationId: 'A32', toStationName: 'W 4 St-Wash Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D21',
    name: 'Broadway-Lafayette St',
    city: 'nyc',
    latitude: 40.725297,
    longitude: -73.996204,
    lines: ['B', 'D', 'F', 'FX', 'M'],
    childPlatforms: ['D21N', 'D21S'],
    transfers: [
      { toStationId: '637', toStationName: 'Bleecker St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'D22',
    name: 'Grand St',
    city: 'nyc',
    latitude: 40.718267,
    longitude: -73.993753,
    lines: ['B', 'D'],
    childPlatforms: ['D22N', 'D22S']
  },
  {
    id: 'D24',
    name: 'Atlantic Av-Barclays Ctr',
    city: 'nyc',
    latitude: 40.68446,
    longitude: -73.97689,
    lines: ['B', 'Q'],
    childPlatforms: ['D24N', 'D24S'],
    transfers: [
      { toStationId: '235', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R31', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'D25',
    name: '7 Av',
    city: 'nyc',
    latitude: 40.67705,
    longitude: -73.972367,
    lines: ['B', 'Q'],
    childPlatforms: ['D25N', 'D25S']
  },
  {
    id: 'D26',
    name: 'Prospect Park',
    city: 'nyc',
    latitude: 40.661614,
    longitude: -73.962246,
    lines: ['B', 'Q', 'S'],
    childPlatforms: ['D26N', 'D26S']
  },
  {
    id: 'D27',
    name: 'Parkside Av',
    city: 'nyc',
    latitude: 40.655292,
    longitude: -73.961495,
    lines: ['Q'],
    childPlatforms: ['D27N', 'D27S']
  },
  {
    id: 'D28',
    name: 'Church Av',
    city: 'nyc',
    latitude: 40.650527,
    longitude: -73.962982,
    lines: ['B', 'Q'],
    childPlatforms: ['D28N', 'D28S']
  },
  {
    id: 'D29',
    name: 'Beverley Rd',
    city: 'nyc',
    latitude: 40.644031,
    longitude: -73.964492,
    lines: ['Q'],
    childPlatforms: ['D29N', 'D29S']
  },
  {
    id: 'D30',
    name: 'Cortelyou Rd',
    city: 'nyc',
    latitude: 40.640927,
    longitude: -73.963891,
    lines: ['Q'],
    childPlatforms: ['D30N', 'D30S']
  },
  {
    id: 'D31',
    name: 'Newkirk Plaza',
    city: 'nyc',
    latitude: 40.635082,
    longitude: -73.962793,
    lines: ['B', 'Q'],
    childPlatforms: ['D31N', 'D31S']
  },
  {
    id: 'D32',
    name: 'Avenue H',
    city: 'nyc',
    latitude: 40.62927,
    longitude: -73.961639,
    lines: ['Q'],
    childPlatforms: ['D32N', 'D32S']
  },
  {
    id: 'D33',
    name: 'Avenue J',
    city: 'nyc',
    latitude: 40.625039,
    longitude: -73.960803,
    lines: ['Q'],
    childPlatforms: ['D33N', 'D33S']
  },
  {
    id: 'D34',
    name: 'Avenue M',
    city: 'nyc',
    latitude: 40.617618,
    longitude: -73.959399,
    lines: ['Q'],
    childPlatforms: ['D34N', 'D34S']
  },
  {
    id: 'D35',
    name: 'Kings Hwy',
    city: 'nyc',
    latitude: 40.60867,
    longitude: -73.957734,
    lines: ['B', 'Q'],
    childPlatforms: ['D35N', 'D35S']
  },
  {
    id: 'D37',
    name: 'Avenue U',
    city: 'nyc',
    latitude: 40.5993,
    longitude: -73.955929,
    lines: ['Q'],
    childPlatforms: ['D37N', 'D37S']
  },
  {
    id: 'D38',
    name: 'Neck Rd',
    city: 'nyc',
    latitude: 40.595246,
    longitude: -73.955161,
    lines: ['Q'],
    childPlatforms: ['D38N', 'D38S']
  },
  {
    id: 'D39',
    name: 'Sheepshead Bay',
    city: 'nyc',
    latitude: 40.586896,
    longitude: -73.954155,
    lines: ['B', 'Q'],
    childPlatforms: ['D39N', 'D39S']
  },
  {
    id: 'D40',
    name: 'Brighton Beach',
    city: 'nyc',
    latitude: 40.577621,
    longitude: -73.961376,
    lines: ['B', 'Q'],
    childPlatforms: ['D40N', 'D40S']
  },
  {
    id: 'D41',
    name: 'Ocean Pkwy',
    city: 'nyc',
    latitude: 40.576312,
    longitude: -73.968501,
    lines: ['Q'],
    childPlatforms: ['D41N', 'D41S']
  },
  {
    id: 'D42',
    name: 'W 8 St-NY Aquarium',
    city: 'nyc',
    latitude: 40.576127,
    longitude: -73.975939,
    lines: ['F', 'FX', 'Q'],
    childPlatforms: ['D42N', 'D42S']
  },
  {
    id: 'D43',
    name: 'Coney Island-Stillwell Av',
    city: 'nyc',
    latitude: 40.577422,
    longitude: -73.981233,
    lines: ['D', 'F', 'FX', 'N', 'Q'],
    childPlatforms: ['D43N', 'D43S']
  },
  {
    id: 'E01',
    name: 'World Trade Center',
    city: 'nyc',
    latitude: 40.712582,
    longitude: -74.009781,
    lines: ['E'],
    childPlatforms: ['E01N', 'E01S'],
    transfers: [
      { toStationId: '228', toStationName: 'Park Place', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R25', toStationName: 'Cortlandt St', transferTime: 240, transferType: 'nearby' },
      { toStationId: 'A36', toStationName: 'Chambers St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'F01',
    name: 'Jamaica-179 St',
    city: 'nyc',
    latitude: 40.712646,
    longitude: -73.783817,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F01N', 'F01S']
  },
  {
    id: 'F02',
    name: '169 St',
    city: 'nyc',
    latitude: 40.71047,
    longitude: -73.793604,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F02N', 'F02S']
  },
  {
    id: 'F03',
    name: 'Parsons Blvd',
    city: 'nyc',
    latitude: 40.707564,
    longitude: -73.803326,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F03N', 'F03S']
  },
  {
    id: 'F04',
    name: 'Sutphin Blvd',
    city: 'nyc',
    latitude: 40.70546,
    longitude: -73.810708,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F04N', 'F04S']
  },
  {
    id: 'F05',
    name: 'Briarwood',
    city: 'nyc',
    latitude: 40.709179,
    longitude: -73.820574,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F05N', 'F05S']
  },
  {
    id: 'F06',
    name: 'Kew Gardens-Union Tpke',
    city: 'nyc',
    latitude: 40.714441,
    longitude: -73.831008,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F06N', 'F06S']
  },
  {
    id: 'F07',
    name: '75 Av',
    city: 'nyc',
    latitude: 40.718331,
    longitude: -73.837324,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F07N', 'F07S']
  },
  {
    id: 'F09',
    name: 'Court Sq-23 St',
    city: 'nyc',
    latitude: 40.747846,
    longitude: -73.946,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F09N', 'F09S'],
    transfers: [
      { toStationId: 'G22', toStationName: 'Court Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: '719', toStationName: 'Court Sq', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'F11',
    name: 'Lexington Av/53 St',
    city: 'nyc',
    latitude: 40.757552,
    longitude: -73.969055,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F11N', 'F11S'],
    transfers: [
      { toStationId: '630', toStationName: '51 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'F12',
    name: '5 Av/53 St',
    city: 'nyc',
    latitude: 40.760167,
    longitude: -73.975224,
    lines: ['E', 'F', 'FX'],
    childPlatforms: ['F12N', 'F12S']
  },
  {
    id: 'F14',
    name: '2 Av',
    city: 'nyc',
    latitude: 40.723402,
    longitude: -73.989938,
    lines: ['F', 'FX'],
    childPlatforms: ['F14N', 'F14S']
  },
  {
    id: 'F15',
    name: 'Delancey St-Essex St',
    city: 'nyc',
    latitude: 40.718611,
    longitude: -73.988114,
    lines: ['F', 'FX'],
    childPlatforms: ['F15N', 'F15S'],
    transfers: [
      { toStationId: 'M18', toStationName: 'Delancey St-Essex St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'F16',
    name: 'East Broadway',
    city: 'nyc',
    latitude: 40.713715,
    longitude: -73.990173,
    lines: ['F', 'FX'],
    childPlatforms: ['F16N', 'F16S']
  },
  {
    id: 'F18',
    name: 'York St',
    city: 'nyc',
    latitude: 40.701397,
    longitude: -73.986751,
    lines: ['F', 'FX'],
    childPlatforms: ['F18N', 'F18S']
  },
  {
    id: 'F20',
    name: 'Bergen St',
    city: 'nyc',
    latitude: 40.686145,
    longitude: -73.990862,
    lines: ['F', 'G'],
    childPlatforms: ['F20N', 'F20S']
  },
  {
    id: 'F21',
    name: 'Carroll St',
    city: 'nyc',
    latitude: 40.680303,
    longitude: -73.995048,
    lines: ['F', 'G'],
    childPlatforms: ['F21N', 'F21S']
  },
  {
    id: 'F22',
    name: 'Smith-9 Sts',
    city: 'nyc',
    latitude: 40.67358,
    longitude: -73.995959,
    lines: ['F', 'G'],
    childPlatforms: ['F22N', 'F22S']
  },
  {
    id: 'F23',
    name: '4 Av-9 St',
    city: 'nyc',
    latitude: 40.670272,
    longitude: -73.989779,
    lines: ['F', 'G'],
    childPlatforms: ['F23N', 'F23S'],
    transfers: [
      { toStationId: 'R33', toStationName: '4 Av-9 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'F24',
    name: '7 Av',
    city: 'nyc',
    latitude: 40.666271,
    longitude: -73.980305,
    lines: ['F', 'FX', 'G'],
    childPlatforms: ['F24N', 'F24S']
  },
  {
    id: 'F25',
    name: '15 St-Prospect Park',
    city: 'nyc',
    latitude: 40.660365,
    longitude: -73.979493,
    lines: ['F', 'G'],
    childPlatforms: ['F25N', 'F25S']
  },
  {
    id: 'F26',
    name: 'Fort Hamilton Pkwy',
    city: 'nyc',
    latitude: 40.650782,
    longitude: -73.975776,
    lines: ['F', 'G'],
    childPlatforms: ['F26N', 'F26S']
  },
  {
    id: 'F27',
    name: 'Church Av',
    city: 'nyc',
    latitude: 40.644041,
    longitude: -73.979678,
    lines: ['F', 'FX', 'G'],
    childPlatforms: ['F27N', 'F27S']
  },
  {
    id: 'F29',
    name: 'Ditmas Av',
    city: 'nyc',
    latitude: 40.636119,
    longitude: -73.978172,
    lines: ['F', 'FX'],
    childPlatforms: ['F29N', 'F29S']
  },
  {
    id: 'F30',
    name: '18 Av',
    city: 'nyc',
    latitude: 40.629755,
    longitude: -73.976971,
    lines: ['F', 'FX'],
    childPlatforms: ['F30N', 'F30S']
  },
  {
    id: 'F31',
    name: 'Avenue I',
    city: 'nyc',
    latitude: 40.625322,
    longitude: -73.976127,
    lines: ['F', 'FX'],
    childPlatforms: ['F31N', 'F31S']
  },
  {
    id: 'F32',
    name: 'Bay Pkwy',
    city: 'nyc',
    latitude: 40.620769,
    longitude: -73.975264,
    lines: ['F', 'FX'],
    childPlatforms: ['F32N', 'F32S']
  },
  {
    id: 'F33',
    name: 'Avenue N',
    city: 'nyc',
    latitude: 40.61514,
    longitude: -73.974197,
    lines: ['F', 'FX'],
    childPlatforms: ['F33N', 'F33S']
  },
  {
    id: 'F34',
    name: 'Avenue P',
    city: 'nyc',
    latitude: 40.608944,
    longitude: -73.973022,
    lines: ['F', 'FX'],
    childPlatforms: ['F34N', 'F34S']
  },
  {
    id: 'F35',
    name: 'Kings Hwy',
    city: 'nyc',
    latitude: 40.603217,
    longitude: -73.972361,
    lines: ['F', 'FX'],
    childPlatforms: ['F35N', 'F35S']
  },
  {
    id: 'F36',
    name: 'Avenue U',
    city: 'nyc',
    latitude: 40.596063,
    longitude: -73.973357,
    lines: ['F', 'FX'],
    childPlatforms: ['F36N', 'F36S']
  },
  {
    id: 'F38',
    name: 'Avenue X',
    city: 'nyc',
    latitude: 40.58962,
    longitude: -73.97425,
    lines: ['F', 'FX'],
    childPlatforms: ['F38N', 'F38S']
  },
  {
    id: 'F39',
    name: 'Neptune Av',
    city: 'nyc',
    latitude: 40.581011,
    longitude: -73.974574,
    lines: ['F', 'FX'],
    childPlatforms: ['F39N', 'F39S']
  },
  {
    id: 'G05',
    name: 'Jamaica Center-Parsons/Archer',
    city: 'nyc',
    latitude: 40.702147,
    longitude: -73.801109,
    lines: ['E', 'J', 'Z'],
    childPlatforms: ['G05N', 'G05S']
  },
  {
    id: 'G06',
    name: 'Sutphin Blvd-Archer Av-JFK Airport',
    city: 'nyc',
    latitude: 40.700486,
    longitude: -73.807969,
    lines: ['E', 'J', 'Z'],
    childPlatforms: ['G06N', 'G06S']
  },
  {
    id: 'G07',
    name: 'Jamaica-Van Wyck',
    city: 'nyc',
    latitude: 40.702566,
    longitude: -73.816859,
    lines: ['E'],
    childPlatforms: ['G07N', 'G07S']
  },
  {
    id: 'G08',
    name: 'Forest Hills-71 Av',
    city: 'nyc',
    latitude: 40.721691,
    longitude: -73.844521,
    lines: ['E', 'F', 'FX', 'M', 'R'],
    childPlatforms: ['G08N', 'G08S']
  },
  {
    id: 'G09',
    name: '67 Av',
    city: 'nyc',
    latitude: 40.726523,
    longitude: -73.852719,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G09N', 'G09S']
  },
  {
    id: 'G10',
    name: '63 Dr-Rego Park',
    city: 'nyc',
    latitude: 40.729846,
    longitude: -73.861604,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G10N', 'G10S']
  },
  {
    id: 'G11',
    name: 'Woodhaven Blvd',
    city: 'nyc',
    latitude: 40.733106,
    longitude: -73.869229,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G11N', 'G11S']
  },
  {
    id: 'G12',
    name: 'Grand Av-Newtown',
    city: 'nyc',
    latitude: 40.737015,
    longitude: -73.877223,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G12N', 'G12S']
  },
  {
    id: 'G13',
    name: 'Elmhurst Av',
    city: 'nyc',
    latitude: 40.742454,
    longitude: -73.882017,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G13N', 'G13S']
  },
  {
    id: 'G14',
    name: 'Jackson Hts-Roosevelt Av',
    city: 'nyc',
    latitude: 40.746644,
    longitude: -73.891338,
    lines: ['E', 'F', 'FX', 'M', 'R'],
    childPlatforms: ['G14N', 'G14S'],
    transfers: [
      { toStationId: '710', toStationName: '74 St-Broadway', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'G15',
    name: '65 St',
    city: 'nyc',
    latitude: 40.749669,
    longitude: -73.898453,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G15N', 'G15S']
  },
  {
    id: 'G16',
    name: 'Northern Blvd',
    city: 'nyc',
    latitude: 40.752885,
    longitude: -73.906006,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G16N', 'G16S']
  },
  {
    id: 'G18',
    name: '46 St',
    city: 'nyc',
    latitude: 40.756312,
    longitude: -73.913333,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G18N', 'G18S']
  },
  {
    id: 'G19',
    name: 'Steinway St',
    city: 'nyc',
    latitude: 40.756879,
    longitude: -73.92074,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G19N', 'G19S']
  },
  {
    id: 'G20',
    name: '36 St',
    city: 'nyc',
    latitude: 40.752039,
    longitude: -73.928781,
    lines: ['E', 'F', 'M', 'R'],
    childPlatforms: ['G20N', 'G20S']
  },
  {
    id: 'G21',
    name: 'Queens Plaza',
    city: 'nyc',
    latitude: 40.748973,
    longitude: -73.937243,
    lines: ['E', 'F', 'FX', 'R'],
    childPlatforms: ['G21N', 'G21S']
  },
  {
    id: 'G22',
    name: 'Court Sq',
    city: 'nyc',
    latitude: 40.746554,
    longitude: -73.943832,
    lines: ['G'],
    childPlatforms: ['G22N', 'G22S'],
    transfers: [
      { toStationId: '719', toStationName: 'Court Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'F09', toStationName: 'Court Sq-23 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'G24',
    name: '21 St',
    city: 'nyc',
    latitude: 40.744065,
    longitude: -73.949724,
    lines: ['G'],
    childPlatforms: ['G24N', 'G24S']
  },
  {
    id: 'G26',
    name: 'Greenpoint Av',
    city: 'nyc',
    latitude: 40.731352,
    longitude: -73.954449,
    lines: ['G'],
    childPlatforms: ['G26N', 'G26S']
  },
  {
    id: 'G28',
    name: 'Nassau Av',
    city: 'nyc',
    latitude: 40.724635,
    longitude: -73.951277,
    lines: ['G'],
    childPlatforms: ['G28N', 'G28S']
  },
  {
    id: 'G29',
    name: 'Metropolitan Av',
    city: 'nyc',
    latitude: 40.712792,
    longitude: -73.951418,
    lines: ['G'],
    childPlatforms: ['G29N', 'G29S'],
    transfers: [
      { toStationId: 'L10', toStationName: 'Lorimer St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'G30',
    name: 'Broadway',
    city: 'nyc',
    latitude: 40.706092,
    longitude: -73.950308,
    lines: ['G'],
    childPlatforms: ['G30N', 'G30S']
  },
  {
    id: 'G31',
    name: 'Flushing Av',
    city: 'nyc',
    latitude: 40.700377,
    longitude: -73.950234,
    lines: ['G'],
    childPlatforms: ['G31N', 'G31S']
  },
  {
    id: 'G32',
    name: 'Myrtle-Willoughby Avs',
    city: 'nyc',
    latitude: 40.694568,
    longitude: -73.949046,
    lines: ['G'],
    childPlatforms: ['G32N', 'G32S']
  },
  {
    id: 'G33',
    name: 'Bedford-Nostrand Avs',
    city: 'nyc',
    latitude: 40.689627,
    longitude: -73.953522,
    lines: ['G'],
    childPlatforms: ['G33N', 'G33S']
  },
  {
    id: 'G34',
    name: 'Classon Av',
    city: 'nyc',
    latitude: 40.688873,
    longitude: -73.96007,
    lines: ['G'],
    childPlatforms: ['G34N', 'G34S']
  },
  {
    id: 'G35',
    name: 'Clinton-Washington Avs',
    city: 'nyc',
    latitude: 40.688089,
    longitude: -73.966839,
    lines: ['G'],
    childPlatforms: ['G35N', 'G35S']
  },
  {
    id: 'G36',
    name: 'Fulton St',
    city: 'nyc',
    latitude: 40.687119,
    longitude: -73.975375,
    lines: ['G'],
    childPlatforms: ['G36N', 'G36S']
  },
  {
    id: 'H01',
    name: 'Aqueduct Racetrack',
    city: 'nyc',
    latitude: 40.672097,
    longitude: -73.835919,
    lines: ['A'],
    childPlatforms: ['H01N', 'H01S']
  },
  {
    id: 'H02',
    name: 'Aqueduct-N Conduit Av',
    city: 'nyc',
    latitude: 40.668234,
    longitude: -73.834058,
    lines: ['A'],
    childPlatforms: ['H02N', 'H02S']
  },
  {
    id: 'H03',
    name: 'Howard Beach-JFK Airport',
    city: 'nyc',
    latitude: 40.660476,
    longitude: -73.830301,
    lines: ['A'],
    childPlatforms: ['H03N', 'H03S']
  },
  {
    id: 'H04',
    name: 'Broad Channel',
    city: 'nyc',
    latitude: 40.608382,
    longitude: -73.815925,
    lines: ['A', 'S'],
    childPlatforms: ['H04N', 'H04S']
  },
  {
    id: 'H06',
    name: 'Beach 67 St',
    city: 'nyc',
    latitude: 40.590927,
    longitude: -73.796924,
    lines: ['A'],
    childPlatforms: ['H06N', 'H06S']
  },
  {
    id: 'H07',
    name: 'Beach 60 St',
    city: 'nyc',
    latitude: 40.592374,
    longitude: -73.788522,
    lines: ['A'],
    childPlatforms: ['H07N', 'H07S']
  },
  {
    id: 'H08',
    name: 'Beach 44 St',
    city: 'nyc',
    latitude: 40.592943,
    longitude: -73.776013,
    lines: ['A'],
    childPlatforms: ['H08N', 'H08S']
  },
  {
    id: 'H09',
    name: 'Beach 36 St',
    city: 'nyc',
    latitude: 40.595398,
    longitude: -73.768175,
    lines: ['A'],
    childPlatforms: ['H09N', 'H09S']
  },
  {
    id: 'H10',
    name: 'Beach 25 St',
    city: 'nyc',
    latitude: 40.600066,
    longitude: -73.761353,
    lines: ['A'],
    childPlatforms: ['H10N', 'H10S']
  },
  {
    id: 'H11',
    name: 'Far Rockaway-Mott Av',
    city: 'nyc',
    latitude: 40.603995,
    longitude: -73.755405,
    lines: ['A'],
    childPlatforms: ['H11N', 'H11S']
  },
  {
    id: 'H12',
    name: 'Beach 90 St',
    city: 'nyc',
    latitude: 40.588034,
    longitude: -73.813641,
    lines: ['A', 'S'],
    childPlatforms: ['H12N', 'H12S']
  },
  {
    id: 'H13',
    name: 'Beach 98 St',
    city: 'nyc',
    latitude: 40.585307,
    longitude: -73.820558,
    lines: ['A', 'S'],
    childPlatforms: ['H13N', 'H13S']
  },
  {
    id: 'H14',
    name: 'Beach 105 St',
    city: 'nyc',
    latitude: 40.583209,
    longitude: -73.827559,
    lines: ['A', 'S'],
    childPlatforms: ['H14N', 'H14S']
  },
  {
    id: 'H15',
    name: 'Rockaway Park-Beach 116 St',
    city: 'nyc',
    latitude: 40.580903,
    longitude: -73.835592,
    lines: ['A', 'S'],
    childPlatforms: ['H15N', 'H15S']
  },
  {
    id: 'J12',
    name: '121 St',
    city: 'nyc',
    latitude: 40.700492,
    longitude: -73.828294,
    lines: ['J', 'Z'],
    childPlatforms: ['J12N', 'J12S']
  },
  {
    id: 'J13',
    name: '111 St',
    city: 'nyc',
    latitude: 40.697418,
    longitude: -73.836345,
    lines: ['J'],
    childPlatforms: ['J13N', 'J13S']
  },
  {
    id: 'J14',
    name: '104 St',
    city: 'nyc',
    latitude: 40.695178,
    longitude: -73.84433,
    lines: ['J', 'Z'],
    childPlatforms: ['J14N', 'J14S']
  },
  {
    id: 'J15',
    name: 'Woodhaven Blvd',
    city: 'nyc',
    latitude: 40.693879,
    longitude: -73.851576,
    lines: ['J', 'Z'],
    childPlatforms: ['J15N', 'J15S']
  },
  {
    id: 'J16',
    name: '85 St-Forest Pkwy',
    city: 'nyc',
    latitude: 40.692435,
    longitude: -73.86001,
    lines: ['J'],
    childPlatforms: ['J16N', 'J16S']
  },
  {
    id: 'J17',
    name: '75 St-Elderts Ln',
    city: 'nyc',
    latitude: 40.691324,
    longitude: -73.867139,
    lines: ['J', 'Z'],
    childPlatforms: ['J17N', 'J17S']
  },
  {
    id: 'J19',
    name: 'Cypress Hills',
    city: 'nyc',
    latitude: 40.689941,
    longitude: -73.87255,
    lines: ['J'],
    childPlatforms: ['J19N', 'J19S']
  },
  {
    id: 'J20',
    name: 'Crescent St',
    city: 'nyc',
    latitude: 40.683194,
    longitude: -73.873785,
    lines: ['J', 'Z'],
    childPlatforms: ['J20N', 'J20S']
  },
  {
    id: 'J21',
    name: 'Norwood Av',
    city: 'nyc',
    latitude: 40.68141,
    longitude: -73.880039,
    lines: ['J', 'Z'],
    childPlatforms: ['J21N', 'J21S']
  },
  {
    id: 'J22',
    name: 'Cleveland St',
    city: 'nyc',
    latitude: 40.679947,
    longitude: -73.884639,
    lines: ['J'],
    childPlatforms: ['J22N', 'J22S']
  },
  {
    id: 'J23',
    name: 'Van Siclen Av',
    city: 'nyc',
    latitude: 40.678024,
    longitude: -73.891688,
    lines: ['J', 'Z'],
    childPlatforms: ['J23N', 'J23S']
  },
  {
    id: 'J24',
    name: 'Alabama Av',
    city: 'nyc',
    latitude: 40.676992,
    longitude: -73.898654,
    lines: ['J', 'Z'],
    childPlatforms: ['J24N', 'J24S']
  },
  {
    id: 'J27',
    name: 'Broadway Junction',
    city: 'nyc',
    latitude: 40.679498,
    longitude: -73.904512,
    lines: ['J', 'Z'],
    childPlatforms: ['J27N', 'J27S'],
    transfers: [
      { toStationId: 'A51', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'L22', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'J28',
    name: 'Chauncey St',
    city: 'nyc',
    latitude: 40.682893,
    longitude: -73.910456,
    lines: ['J', 'Z'],
    childPlatforms: ['J28N', 'J28S']
  },
  {
    id: 'J29',
    name: 'Halsey St',
    city: 'nyc',
    latitude: 40.68637,
    longitude: -73.916559,
    lines: ['J'],
    childPlatforms: ['J29N', 'J29S']
  },
  {
    id: 'J30',
    name: 'Gates Av',
    city: 'nyc',
    latitude: 40.68963,
    longitude: -73.92227,
    lines: ['J', 'Z'],
    childPlatforms: ['J30N', 'J30S']
  },
  {
    id: 'J31',
    name: 'Kosciuszko St',
    city: 'nyc',
    latitude: 40.693342,
    longitude: -73.928814,
    lines: ['J'],
    childPlatforms: ['J31N', 'J31S']
  },
  {
    id: 'L01',
    name: '8 Av',
    city: 'nyc',
    latitude: 40.739777,
    longitude: -74.002578,
    lines: ['L'],
    childPlatforms: ['L01N', 'L01S'],
    transfers: [
      { toStationId: 'A31', toStationName: '14 St', transferTime: 90, transferType: 'nearby' }
    ]
  },
  {
    id: 'L02',
    name: '6 Av',
    city: 'nyc',
    latitude: 40.737335,
    longitude: -73.996786,
    lines: ['L'],
    childPlatforms: ['L02N', 'L02S'],
    transfers: [
      { toStationId: '132', toStationName: '14 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'D19', toStationName: '14 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'L03',
    name: '14 St-Union Sq',
    city: 'nyc',
    latitude: 40.734789,
    longitude: -73.99073,
    lines: ['L'],
    childPlatforms: ['L03N', 'L03S'],
    transfers: [
      { toStationId: '635', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R20', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'L05',
    name: '3 Av',
    city: 'nyc',
    latitude: 40.732849,
    longitude: -73.986122,
    lines: ['L'],
    childPlatforms: ['L05N', 'L05S']
  },
  {
    id: 'L06',
    name: '1 Av',
    city: 'nyc',
    latitude: 40.730953,
    longitude: -73.981628,
    lines: ['L'],
    childPlatforms: ['L06N', 'L06S']
  },
  {
    id: 'L08',
    name: 'Bedford Av',
    city: 'nyc',
    latitude: 40.717304,
    longitude: -73.956872,
    lines: ['L'],
    childPlatforms: ['L08N', 'L08S']
  },
  {
    id: 'L10',
    name: 'Lorimer St',
    city: 'nyc',
    latitude: 40.714063,
    longitude: -73.950275,
    lines: ['L'],
    childPlatforms: ['L10N', 'L10S'],
    transfers: [
      { toStationId: 'G29', toStationName: 'Metropolitan Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'L11',
    name: 'Graham Av',
    city: 'nyc',
    latitude: 40.714565,
    longitude: -73.944053,
    lines: ['L'],
    childPlatforms: ['L11N', 'L11S']
  },
  {
    id: 'L12',
    name: 'Grand St',
    city: 'nyc',
    latitude: 40.711926,
    longitude: -73.94067,
    lines: ['L'],
    childPlatforms: ['L12N', 'L12S']
  },
  {
    id: 'L13',
    name: 'Montrose Av',
    city: 'nyc',
    latitude: 40.707739,
    longitude: -73.93985,
    lines: ['L'],
    childPlatforms: ['L13N', 'L13S']
  },
  {
    id: 'L14',
    name: 'Morgan Av',
    city: 'nyc',
    latitude: 40.706152,
    longitude: -73.933147,
    lines: ['L'],
    childPlatforms: ['L14N', 'L14S']
  },
  {
    id: 'L15',
    name: 'Jefferson St',
    city: 'nyc',
    latitude: 40.706607,
    longitude: -73.922913,
    lines: ['L'],
    childPlatforms: ['L15N', 'L15S']
  },
  {
    id: 'L16',
    name: 'DeKalb Av',
    city: 'nyc',
    latitude: 40.703811,
    longitude: -73.918425,
    lines: ['L'],
    childPlatforms: ['L16N', 'L16S']
  },
  {
    id: 'L17',
    name: 'Myrtle-Wyckoff Avs',
    city: 'nyc',
    latitude: 40.699814,
    longitude: -73.911586,
    lines: ['L'],
    childPlatforms: ['L17N', 'L17S'],
    transfers: [
      { toStationId: 'M08', toStationName: 'Myrtle-Wyckoff Avs', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'L19',
    name: 'Halsey St',
    city: 'nyc',
    latitude: 40.695602,
    longitude: -73.904084,
    lines: ['L'],
    childPlatforms: ['L19N', 'L19S']
  },
  {
    id: 'L20',
    name: 'Wilson Av',
    city: 'nyc',
    latitude: 40.688764,
    longitude: -73.904046,
    lines: ['L'],
    childPlatforms: ['L20N', 'L20S']
  },
  {
    id: 'L21',
    name: 'Bushwick Av-Aberdeen St',
    city: 'nyc',
    latitude: 40.682829,
    longitude: -73.905249,
    lines: ['L'],
    childPlatforms: ['L21N', 'L21S']
  },
  {
    id: 'L22',
    name: 'Broadway Junction',
    city: 'nyc',
    latitude: 40.678856,
    longitude: -73.90324,
    lines: ['L'],
    childPlatforms: ['L22N', 'L22S'],
    transfers: [
      { toStationId: 'A51', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'J27', toStationName: 'Broadway Junction', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'L24',
    name: 'Atlantic Av',
    city: 'nyc',
    latitude: 40.675345,
    longitude: -73.903097,
    lines: ['L'],
    childPlatforms: ['L24N', 'L24S']
  },
  {
    id: 'L25',
    name: 'Sutter Av',
    city: 'nyc',
    latitude: 40.669367,
    longitude: -73.901975,
    lines: ['L'],
    childPlatforms: ['L25N', 'L25S']
  },
  {
    id: 'L26',
    name: 'Livonia Av',
    city: 'nyc',
    latitude: 40.664038,
    longitude: -73.900571,
    lines: ['L'],
    childPlatforms: ['L26N', 'L26S'],
    transfers: [
      { toStationId: '254', toStationName: 'Junius St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'L27',
    name: 'New Lots Av',
    city: 'nyc',
    latitude: 40.658733,
    longitude: -73.899232,
    lines: ['L'],
    childPlatforms: ['L27N', 'L27S']
  },
  {
    id: 'L28',
    name: 'East 105 St',
    city: 'nyc',
    latitude: 40.650573,
    longitude: -73.899485,
    lines: ['L'],
    childPlatforms: ['L28N', 'L28S']
  },
  {
    id: 'L29',
    name: 'Canarsie-Rockaway Pkwy',
    city: 'nyc',
    latitude: 40.646654,
    longitude: -73.90185,
    lines: ['L'],
    childPlatforms: ['L29N', 'L29S']
  },
  {
    id: 'M01',
    name: 'Middle Village-Metropolitan Av',
    city: 'nyc',
    latitude: 40.711396,
    longitude: -73.889601,
    lines: ['M'],
    childPlatforms: ['M01N', 'M01S']
  },
  {
    id: 'M04',
    name: 'Fresh Pond Rd',
    city: 'nyc',
    latitude: 40.706186,
    longitude: -73.895877,
    lines: ['M'],
    childPlatforms: ['M04N', 'M04S']
  },
  {
    id: 'M05',
    name: 'Forest Av',
    city: 'nyc',
    latitude: 40.704423,
    longitude: -73.903077,
    lines: ['M'],
    childPlatforms: ['M05N', 'M05S']
  },
  {
    id: 'M06',
    name: 'Seneca Av',
    city: 'nyc',
    latitude: 40.702762,
    longitude: -73.90774,
    lines: ['M'],
    childPlatforms: ['M06N', 'M06S']
  },
  {
    id: 'M08',
    name: 'Myrtle-Wyckoff Avs',
    city: 'nyc',
    latitude: 40.69943,
    longitude: -73.912385,
    lines: ['M'],
    childPlatforms: ['M08N', 'M08S'],
    transfers: [
      { toStationId: 'L17', toStationName: 'Myrtle-Wyckoff Avs', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'M09',
    name: 'Knickerbocker Av',
    city: 'nyc',
    latitude: 40.698664,
    longitude: -73.919711,
    lines: ['M'],
    childPlatforms: ['M09N', 'M09S']
  },
  {
    id: 'M10',
    name: 'Central Av',
    city: 'nyc',
    latitude: 40.697857,
    longitude: -73.927397,
    lines: ['M'],
    childPlatforms: ['M10N', 'M10S']
  },
  {
    id: 'M11',
    name: 'Myrtle Av',
    city: 'nyc',
    latitude: 40.697207,
    longitude: -73.935657,
    lines: ['J', 'M', 'Z'],
    childPlatforms: ['M11N', 'M11S']
  },
  {
    id: 'M12',
    name: 'Flushing Av',
    city: 'nyc',
    latitude: 40.70026,
    longitude: -73.941126,
    lines: ['J', 'M'],
    childPlatforms: ['M12N', 'M12S']
  },
  {
    id: 'M13',
    name: 'Lorimer St',
    city: 'nyc',
    latitude: 40.703869,
    longitude: -73.947408,
    lines: ['J', 'M'],
    childPlatforms: ['M13N', 'M13S']
  },
  {
    id: 'M14',
    name: 'Hewes St',
    city: 'nyc',
    latitude: 40.70687,
    longitude: -73.953431,
    lines: ['J', 'M'],
    childPlatforms: ['M14N', 'M14S']
  },
  {
    id: 'M16',
    name: 'Marcy Av',
    city: 'nyc',
    latitude: 40.708359,
    longitude: -73.957757,
    lines: ['J', 'M', 'Z'],
    childPlatforms: ['M16N', 'M16S']
  },
  {
    id: 'M18',
    name: 'Delancey St-Essex St',
    city: 'nyc',
    latitude: 40.718315,
    longitude: -73.987437,
    lines: ['J', 'M', 'Z'],
    childPlatforms: ['M18N', 'M18S'],
    transfers: [
      { toStationId: 'F15', toStationName: 'Delancey St-Essex St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'M19',
    name: 'Bowery',
    city: 'nyc',
    latitude: 40.72028,
    longitude: -73.993915,
    lines: ['J', 'Z'],
    childPlatforms: ['M19N', 'M19S']
  },
  {
    id: 'M20',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.718092,
    longitude: -73.999892,
    lines: ['J', 'Z'],
    childPlatforms: ['M20N', 'M20S'],
    transfers: [
      { toStationId: '639', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'Q01', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R23', toStationName: 'Canal St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'M21',
    name: 'Chambers St',
    city: 'nyc',
    latitude: 40.713243,
    longitude: -74.003401,
    lines: ['J', 'Z'],
    childPlatforms: ['M21N', 'M21S'],
    transfers: [
      { toStationId: '640', toStationName: 'Brooklyn Bridge-City Hall', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'M22',
    name: 'Fulton St',
    city: 'nyc',
    latitude: 40.710374,
    longitude: -74.007582,
    lines: ['J', 'Z'],
    childPlatforms: ['M22N', 'M22S'],
    transfers: [
      { toStationId: 'A38', toStationName: 'Fulton St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '229', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' },
      { toStationId: '418', toStationName: 'Fulton St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'M23',
    name: 'Broad St',
    city: 'nyc',
    latitude: 40.706476,
    longitude: -74.011056,
    lines: ['J', 'Z'],
    childPlatforms: ['M23N', 'M23S']
  },
  {
    id: 'N02',
    name: '8 Av',
    city: 'nyc',
    latitude: 40.635064,
    longitude: -74.011719,
    lines: ['N', 'W'],
    childPlatforms: ['N02N', 'N02S']
  },
  {
    id: 'N03',
    name: 'Fort Hamilton Pkwy',
    city: 'nyc',
    latitude: 40.631386,
    longitude: -74.005351,
    lines: ['N', 'W'],
    childPlatforms: ['N03N', 'N03S']
  },
  {
    id: 'N04',
    name: 'New Utrecht Av',
    city: 'nyc',
    latitude: 40.624842,
    longitude: -73.996353,
    lines: ['N', 'W'],
    childPlatforms: ['N04N', 'N04S'],
    transfers: [
      { toStationId: 'B16', toStationName: '62 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'N05',
    name: '18 Av',
    city: 'nyc',
    latitude: 40.620671,
    longitude: -73.990414,
    lines: ['N', 'W'],
    childPlatforms: ['N05N', 'N05S']
  },
  {
    id: 'N06',
    name: '20 Av',
    city: 'nyc',
    latitude: 40.61741,
    longitude: -73.985026,
    lines: ['N', 'W'],
    childPlatforms: ['N06N', 'N06S']
  },
  {
    id: 'N07',
    name: 'Bay Pkwy',
    city: 'nyc',
    latitude: 40.611815,
    longitude: -73.981848,
    lines: ['N', 'W'],
    childPlatforms: ['N07N', 'N07S']
  },
  {
    id: 'N08',
    name: 'Kings Hwy',
    city: 'nyc',
    latitude: 40.603923,
    longitude: -73.980353,
    lines: ['N', 'W'],
    childPlatforms: ['N08N', 'N08S']
  },
  {
    id: 'N09',
    name: 'Avenue U',
    city: 'nyc',
    latitude: 40.597473,
    longitude: -73.979137,
    lines: ['N', 'W'],
    childPlatforms: ['N09N', 'N09S']
  },
  {
    id: 'N10',
    name: '86 St',
    city: 'nyc',
    latitude: 40.592721,
    longitude: -73.97823,
    lines: ['N', 'W'],
    childPlatforms: ['N10N', 'N10S']
  },
  {
    id: 'Q01',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.718383,
    longitude: -74.00046,
    lines: ['N', 'Q'],
    childPlatforms: ['Q01N', 'Q01S'],
    transfers: [
      { toStationId: '639', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'M20', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'R23', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'Q03',
    name: '72 St',
    city: 'nyc',
    latitude: 40.768799,
    longitude: -73.958424,
    lines: ['N', 'Q', 'R'],
    childPlatforms: ['Q03N', 'Q03S']
  },
  {
    id: 'Q04',
    name: '86 St',
    city: 'nyc',
    latitude: 40.777891,
    longitude: -73.951787,
    lines: ['N', 'Q', 'R'],
    childPlatforms: ['Q04N', 'Q04S']
  },
  {
    id: 'Q05',
    name: '96 St',
    city: 'nyc',
    latitude: 40.784318,
    longitude: -73.947152,
    lines: ['N', 'Q', 'R'],
    childPlatforms: ['Q05N', 'Q05S']
  },
  {
    id: 'R01',
    name: 'Astoria-Ditmars Blvd',
    city: 'nyc',
    latitude: 40.775036,
    longitude: -73.912034,
    lines: ['N', 'W'],
    childPlatforms: ['R01N', 'R01S']
  },
  {
    id: 'R03',
    name: 'Astoria Blvd',
    city: 'nyc',
    latitude: 40.770258,
    longitude: -73.917843,
    lines: ['N', 'W'],
    childPlatforms: ['R03N', 'R03S']
  },
  {
    id: 'R04',
    name: '30 Av',
    city: 'nyc',
    latitude: 40.766779,
    longitude: -73.921479,
    lines: ['N', 'W'],
    childPlatforms: ['R04N', 'R04S']
  },
  {
    id: 'R05',
    name: 'Broadway',
    city: 'nyc',
    latitude: 40.76182,
    longitude: -73.925508,
    lines: ['N', 'W'],
    childPlatforms: ['R05N', 'R05S']
  },
  {
    id: 'R06',
    name: '36 Av',
    city: 'nyc',
    latitude: 40.756804,
    longitude: -73.929575,
    lines: ['N', 'W'],
    childPlatforms: ['R06N', 'R06S']
  },
  {
    id: 'R08',
    name: '39 Av-Dutch Kills',
    city: 'nyc',
    latitude: 40.752882,
    longitude: -73.932755,
    lines: ['N', 'W'],
    childPlatforms: ['R08N', 'R08S']
  },
  {
    id: 'R09',
    name: 'Queensboro Plaza',
    city: 'nyc',
    latitude: 40.750582,
    longitude: -73.940202,
    lines: ['N', 'W'],
    childPlatforms: ['R09N', 'R09S'],
    transfers: [
      { toStationId: '718', toStationName: 'Queensboro Plaza', transferTime: 0, transferType: 'nearby' }
    ]
  },
  {
    id: 'R11',
    name: 'Lexington Av/59 St',
    city: 'nyc',
    latitude: 40.76266,
    longitude: -73.967258,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R11N', 'R11S'],
    transfers: [
      { toStationId: '629', toStationName: '59 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'B08', toStationName: 'Lexington Av/63 St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'R13',
    name: '5 Av/59 St',
    city: 'nyc',
    latitude: 40.764811,
    longitude: -73.973347,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R13N', 'R13S']
  },
  {
    id: 'R14',
    name: '57 St-7 Av',
    city: 'nyc',
    latitude: 40.764664,
    longitude: -73.980658,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R14N', 'R14S']
  },
  {
    id: 'R15',
    name: '49 St',
    city: 'nyc',
    latitude: 40.759901,
    longitude: -73.984139,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R15N', 'R15S']
  },
  {
    id: 'R16',
    name: 'Times Sq-42 St',
    city: 'nyc',
    latitude: 40.754672,
    longitude: -73.986754,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R16N', 'R16S'],
    transfers: [
      { toStationId: '127', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '725', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: '902', toStationName: 'Times Sq-42 St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'A27', toStationName: '42 St-Port Authority Bus Terminal', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'R17',
    name: '34 St-Herald Sq',
    city: 'nyc',
    latitude: 40.749567,
    longitude: -73.98795,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R17N', 'R17S'],
    transfers: [
      { toStationId: 'D17', toStationName: '34 St-Herald Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'R18',
    name: '28 St',
    city: 'nyc',
    latitude: 40.745494,
    longitude: -73.988691,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R18N', 'R18S']
  },
  {
    id: 'R19',
    name: '23 St',
    city: 'nyc',
    latitude: 40.741303,
    longitude: -73.989344,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R19N', 'R19S']
  },
  {
    id: 'R20',
    name: '14 St-Union Sq',
    city: 'nyc',
    latitude: 40.735736,
    longitude: -73.990568,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R20N', 'R20S'],
    transfers: [
      { toStationId: '635', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'L03', toStationName: '14 St-Union Sq', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'R21',
    name: '8 St-NYU',
    city: 'nyc',
    latitude: 40.730328,
    longitude: -73.992629,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R21N', 'R21S']
  },
  {
    id: 'R22',
    name: 'Prince St',
    city: 'nyc',
    latitude: 40.724329,
    longitude: -73.997702,
    lines: ['N', 'Q', 'R', 'W'],
    childPlatforms: ['R22N', 'R22S']
  },
  {
    id: 'R23',
    name: 'Canal St',
    city: 'nyc',
    latitude: 40.719527,
    longitude: -74.001775,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R23N', 'R23S'],
    transfers: [
      { toStationId: '639', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'Q01', toStationName: 'Canal St', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'M20', toStationName: 'Canal St', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'R24',
    name: 'City Hall',
    city: 'nyc',
    latitude: 40.713282,
    longitude: -74.006978,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R24N', 'R24S']
  },
  {
    id: 'R25',
    name: 'Cortlandt St',
    city: 'nyc',
    latitude: 40.710668,
    longitude: -74.011029,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R25N', 'R25S'],
    transfers: [
      { toStationId: 'E01', toStationName: 'World Trade Center', transferTime: 240, transferType: 'nearby' },
      { toStationId: 'A36', toStationName: 'Chambers St', transferTime: 420, transferType: 'nearby' },
      { toStationId: '228', toStationName: 'Park Place', transferTime: 420, transferType: 'nearby' }
    ]
  },
  {
    id: 'R26',
    name: 'Rector St',
    city: 'nyc',
    latitude: 40.70722,
    longitude: -74.013342,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R26N', 'R26S']
  },
  {
    id: 'R27',
    name: 'Whitehall St-South Ferry',
    city: 'nyc',
    latitude: 40.703087,
    longitude: -74.012994,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R27N', 'R27S']
  },
  {
    id: 'R28',
    name: 'Court St',
    city: 'nyc',
    latitude: 40.6941,
    longitude: -73.991777,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R28N', 'R28S'],
    transfers: [
      { toStationId: '232', toStationName: 'Borough Hall', transferTime: 180, transferType: 'nearby' },
      { toStationId: '423', toStationName: 'Borough Hall', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'R29',
    name: 'Jay St-MetroTech',
    city: 'nyc',
    latitude: 40.69218,
    longitude: -73.985942,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R29N', 'R29S'],
    transfers: [
      { toStationId: 'A41', toStationName: 'Jay St-MetroTech', transferTime: 90, transferType: 'nearby' }
    ]
  },
  {
    id: 'R30',
    name: 'DeKalb Av',
    city: 'nyc',
    latitude: 40.690635,
    longitude: -73.981824,
    lines: ['B', 'D', 'N', 'Q', 'R', 'W'],
    childPlatforms: ['R30N', 'R30S']
  },
  {
    id: 'R31',
    name: 'Atlantic Av-Barclays Ctr',
    city: 'nyc',
    latitude: 40.683666,
    longitude: -73.97881,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R31N', 'R31S'],
    transfers: [
      { toStationId: '235', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 180, transferType: 'nearby' },
      { toStationId: 'D24', toStationName: 'Atlantic Av-Barclays Ctr', transferTime: 300, transferType: 'nearby' }
    ]
  },
  {
    id: 'R32',
    name: 'Union St',
    city: 'nyc',
    latitude: 40.677316,
    longitude: -73.98311,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R32N', 'R32S']
  },
  {
    id: 'R33',
    name: '4 Av-9 St',
    city: 'nyc',
    latitude: 40.670847,
    longitude: -73.988302,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R33N', 'R33S'],
    transfers: [
      { toStationId: 'F23', toStationName: '4 Av-9 St', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'R34',
    name: 'Prospect Av',
    city: 'nyc',
    latitude: 40.665414,
    longitude: -73.992872,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R34N', 'R34S']
  },
  {
    id: 'R35',
    name: '25 St',
    city: 'nyc',
    latitude: 40.660397,
    longitude: -73.998091,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R35N', 'R35S']
  },
  {
    id: 'R36',
    name: '36 St',
    city: 'nyc',
    latitude: 40.655144,
    longitude: -74.003549,
    lines: ['D', 'N', 'R', 'W'],
    childPlatforms: ['R36N', 'R36S']
  },
  {
    id: 'R39',
    name: '45 St',
    city: 'nyc',
    latitude: 40.648939,
    longitude: -74.010006,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R39N', 'R39S']
  },
  {
    id: 'R40',
    name: '53 St',
    city: 'nyc',
    latitude: 40.645069,
    longitude: -74.014034,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R40N', 'R40S']
  },
  {
    id: 'R41',
    name: '59 St',
    city: 'nyc',
    latitude: 40.641362,
    longitude: -74.017881,
    lines: ['N', 'R', 'W'],
    childPlatforms: ['R41N', 'R41S']
  },
  {
    id: 'R42',
    name: 'Bay Ridge Av',
    city: 'nyc',
    latitude: 40.634967,
    longitude: -74.023377,
    lines: ['R'],
    childPlatforms: ['R42N', 'R42S']
  },
  {
    id: 'R43',
    name: '77 St',
    city: 'nyc',
    latitude: 40.629742,
    longitude: -74.02551,
    lines: ['R'],
    childPlatforms: ['R43N', 'R43S']
  },
  {
    id: 'R44',
    name: '86 St',
    city: 'nyc',
    latitude: 40.622687,
    longitude: -74.028398,
    lines: ['R'],
    childPlatforms: ['R44N', 'R44S']
  },
  {
    id: 'R45',
    name: 'Bay Ridge-95 St',
    city: 'nyc',
    latitude: 40.616622,
    longitude: -74.030876,
    lines: ['R'],
    childPlatforms: ['R45N', 'R45S']
  },
  {
    id: 'S01',
    name: 'Franklin Av',
    city: 'nyc',
    latitude: 40.680596,
    longitude: -73.955827,
    lines: ['S'],
    childPlatforms: ['S01N', 'S01S'],
    transfers: [
      { toStationId: 'A45', toStationName: 'Franklin Av', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'S03',
    name: 'Park Pl',
    city: 'nyc',
    latitude: 40.674772,
    longitude: -73.957624,
    lines: ['S'],
    childPlatforms: ['S03N', 'S03S']
  },
  {
    id: 'S04',
    name: 'Botanic Garden',
    city: 'nyc',
    latitude: 40.670343,
    longitude: -73.959245,
    lines: ['S'],
    childPlatforms: ['S04N', 'S04S'],
    transfers: [
      { toStationId: '239', toStationName: 'Franklin Av-Medgar Evers College', transferTime: 180, transferType: 'nearby' }
    ]
  },
  {
    id: 'S09',
    name: 'Tottenville',
    city: 'nyc',
    latitude: 40.512764,
    longitude: -74.251961,
    lines: ['SIR'],
    childPlatforms: ['S09N', 'S09S']
  },
  {
    id: 'S11',
    name: 'Arthur Kill',
    city: 'nyc',
    latitude: 40.516578,
    longitude: -74.242096,
    lines: ['SIR'],
    childPlatforms: ['S11N', 'S11S']
  },
  {
    id: 'S13',
    name: 'Richmond Valley',
    city: 'nyc',
    latitude: 40.519631,
    longitude: -74.229141,
    lines: ['SIR'],
    childPlatforms: ['S13N', 'S13S']
  },
  {
    id: 'S14',
    name: 'Pleasant Plains',
    city: 'nyc',
    latitude: 40.52241,
    longitude: -74.217847,
    lines: ['SIR'],
    childPlatforms: ['S14N', 'S14S']
  },
  {
    id: 'S15',
    name: 'Prince\'s Bay',
    city: 'nyc',
    latitude: 40.525507,
    longitude: -74.200064,
    lines: ['SIR'],
    childPlatforms: ['S15N', 'S15S']
  },
  {
    id: 'S16',
    name: 'Huguenot',
    city: 'nyc',
    latitude: 40.533674,
    longitude: -74.191794,
    lines: ['SIR'],
    childPlatforms: ['S16N', 'S16S']
  },
  {
    id: 'S17',
    name: 'Annadale',
    city: 'nyc',
    latitude: 40.54046,
    longitude: -74.178217,
    lines: ['SIR'],
    childPlatforms: ['S17N', 'S17S']
  },
  {
    id: 'S18',
    name: 'Eltingville',
    city: 'nyc',
    latitude: 40.544601,
    longitude: -74.16457,
    lines: ['SIR'],
    childPlatforms: ['S18N', 'S18S']
  },
  {
    id: 'S19',
    name: 'Great Kills',
    city: 'nyc',
    latitude: 40.551231,
    longitude: -74.151399,
    lines: ['SIR'],
    childPlatforms: ['S19N', 'S19S']
  },
  {
    id: 'S20',
    name: 'Bay Terrace',
    city: 'nyc',
    latitude: 40.5564,
    longitude: -74.136907,
    lines: ['SIR'],
    childPlatforms: ['S20N', 'S20S']
  },
  {
    id: 'S21',
    name: 'Oakwood Heights',
    city: 'nyc',
    latitude: 40.56511,
    longitude: -74.12632,
    lines: ['SIR'],
    childPlatforms: ['S21N', 'S21S']
  },
  {
    id: 'S22',
    name: 'New Dorp',
    city: 'nyc',
    latitude: 40.57348,
    longitude: -74.11721,
    lines: ['SIR'],
    childPlatforms: ['S22N', 'S22S']
  },
  {
    id: 'S23',
    name: 'Grant City',
    city: 'nyc',
    latitude: 40.578965,
    longitude: -74.109704,
    lines: ['SIR'],
    childPlatforms: ['S23N', 'S23S']
  },
  {
    id: 'S24',
    name: 'Jefferson Av',
    city: 'nyc',
    latitude: 40.583591,
    longitude: -74.103338,
    lines: ['SIR'],
    childPlatforms: ['S24N', 'S24S']
  },
  {
    id: 'S25',
    name: 'Dongan Hills',
    city: 'nyc',
    latitude: 40.588849,
    longitude: -74.09609,
    lines: ['SIR'],
    childPlatforms: ['S25N', 'S25S']
  },
  {
    id: 'S26',
    name: 'Old Town',
    city: 'nyc',
    latitude: 40.596612,
    longitude: -74.087368,
    lines: ['SIR'],
    childPlatforms: ['S26N', 'S26S']
  },
  {
    id: 'S27',
    name: 'Grasmere',
    city: 'nyc',
    latitude: 40.603117,
    longitude: -74.084087,
    lines: ['SIR'],
    childPlatforms: ['S27N', 'S27S']
  },
  {
    id: 'S28',
    name: 'Clifton',
    city: 'nyc',
    latitude: 40.621319,
    longitude: -74.071402,
    lines: ['SIR'],
    childPlatforms: ['S28N', 'S28S']
  },
  {
    id: 'S29',
    name: 'Stapleton',
    city: 'nyc',
    latitude: 40.627915,
    longitude: -74.075162,
    lines: ['SIR'],
    childPlatforms: ['S29N', 'S29S']
  },
  {
    id: 'S30',
    name: 'Tompkinsville',
    city: 'nyc',
    latitude: 40.636949,
    longitude: -74.074835,
    lines: ['SIR'],
    childPlatforms: ['S30N', 'S30S']
  },
  {
    id: 'S31',
    name: 'St George',
    city: 'nyc',
    latitude: 40.643748,
    longitude: -74.073643,
    lines: ['SIR'],
    childPlatforms: ['S31N', 'S31S']
  }
];
