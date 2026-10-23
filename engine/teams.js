// Team identities across sources: ESPN abbreviation (data), NBA abbreviation (injury PDF matchups) and the
// nickname key that `teamKey` derives from a full name ("Trail Blazers" -> "blazers").
// Betman Korean names are added in P7 and checked against the first odds capture (design §10).
export const TEAMS = [
  ['ATL', 'ATL', 'Atlanta Hawks'], ['BKN', 'BKN', 'Brooklyn Nets'], ['BOS', 'BOS', 'Boston Celtics'],
  ['CHA', 'CHA', 'Charlotte Hornets'], ['CHI', 'CHI', 'Chicago Bulls'], ['CLE', 'CLE', 'Cleveland Cavaliers'],
  ['DAL', 'DAL', 'Dallas Mavericks'], ['DEN', 'DEN', 'Denver Nuggets'], ['DET', 'DET', 'Detroit Pistons'],
  ['GS', 'GSW', 'Golden State Warriors'], ['HOU', 'HOU', 'Houston Rockets'], ['IND', 'IND', 'Indiana Pacers'],
  ['LAC', 'LAC', 'LA Clippers'], ['LAL', 'LAL', 'Los Angeles Lakers'], ['MEM', 'MEM', 'Memphis Grizzlies'],
  ['MIA', 'MIA', 'Miami Heat'], ['MIL', 'MIL', 'Milwaukee Bucks'], ['MIN', 'MIN', 'Minnesota Timberwolves'],
  ['NO', 'NOP', 'New Orleans Pelicans'], ['NY', 'NYK', 'New York Knicks'], ['OKC', 'OKC', 'Oklahoma City Thunder'],
  ['ORL', 'ORL', 'Orlando Magic'], ['PHI', 'PHI', 'Philadelphia 76ers'], ['PHX', 'PHX', 'Phoenix Suns'],
  ['POR', 'POR', 'Portland Trail Blazers'], ['SA', 'SAS', 'San Antonio Spurs'], ['SAC', 'SAC', 'Sacramento Kings'],
  ['TOR', 'TOR', 'Toronto Raptors'], ['UTAH', 'UTA', 'Utah Jazz'], ['WSH', 'WAS', 'Washington Wizards'],
].map(([espn, nba, name]) => ({ espn, nba, name, key: name.split(/\s+/).at(-1).toLowerCase() }));

export const byEspn = abbr => TEAMS.find(t => t.espn === abbr);
export const byNba = abbr => TEAMS.find(t => t.nba === abbr);
export const byKey = key => TEAMS.find(t => t.key === key);
