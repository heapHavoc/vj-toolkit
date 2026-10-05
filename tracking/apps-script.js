// ================================================================
// SHOPIFY THEME TOOLKIT — USAGE TRACKING
// Google Apps Script
//
// SETUP STEPS (do once):
//   1. Open a new Google Sheet
//   2. Extensions → Apps Script → paste this entire file
//   3. Run initializeSheets() manually (Run menu → initializeSheets)
//   4. Deploy → New deployment → Web App
//      Execute as: Me | Who has access: Anyone
//   5. Copy the Web App URL — this is SHOPIFY_TOOLKIT_TRACKING_URL
//      Current: https://script.google.com/macros/s/AKfycbxBQ90rMnmE-AYkQlaTF1XVretzK2pE2UN9XPgleOVHV-4BYwWaV0esQT6ymtGsjlvD7A/exec
//   6. Share the URL + token with your team
// ================================================================

const TRACKING_TOKEN = 'shopify-theme-toolkit';

const VALID_SKILLS = [
  'clarify', 'plan', 'execute', 'test', 'code-review',
  'fix', 'figma', 'compare', 'research', 'understand',
  'liquid-standards', 'section-standards', 'css-standards',
  'js-standards', 'theme-architecture'
];

// Skills grouped for column ordering in User Level sheet
const WORKFLOW_SKILLS    = ['clarify', 'plan', 'execute', 'test', 'code-review'];
const STANDALONE_SKILLS  = ['fix', 'figma', 'compare', 'research', 'understand'];
const STANDARDS_SKILLS   = ['liquid-standards', 'section-standards', 'css-standards', 'js-standards', 'theme-architecture'];
const ALL_SKILLS = [...WORKFLOW_SKILLS, ...STANDALONE_SKILLS, ...STANDARDS_SKILLS];


// ----------------------------------------------------------------
// HTTP ENDPOINT — receives POST from hook
// ----------------------------------------------------------------

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.token !== TRACKING_TOKEN) {
      return jsonResponse({ error: 'Unauthorized' });
    }

    if (!VALID_SKILLS.includes(data.skill)) {
      return jsonResponse({ skipped: 'not a tracked skill' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = data.user || 'unknown';
    const skill = data.skill;
    const timestamp = data.timestamp || new Date().toISOString();

    const project = data.project || 'unknown';

    updateSkillLevel_(ss, skill, user, timestamp);
    updateUserLevel_(ss, skill, user, timestamp);
    updateProjectLevel_(ss, skill, project, timestamp);

    return jsonResponse({ success: true });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// ----------------------------------------------------------------
// SKILL LEVEL — direct increment
// ----------------------------------------------------------------

function updateSkillLevel_(ss, skill, user, timestamp) {
  const sheet = ss.getSheetByName('Skill Level');
  const lastRow = sheet.getLastRow();

  // Find the skill row (column A = skill name, starting row 2)
  let skillRow = -1;
  if (lastRow >= 2) {
    const skills = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < skills.length; i++) {
      if (skills[i][0] === skill) {
        skillRow = i + 2;
        break;
      }
    }
  }

  if (skillRow === -1) return; // skill not found in sheet (shouldn't happen after init)

  // Column layout: Skill(A) | Total Uses(B) | Unique Users(C) | Last Used(D)
  const currentCount = sheet.getRange(skillRow, 2).getValue() || 0;
  sheet.getRange(skillRow, 2).setValue(currentCount + 1);

  // Unique users: stored as comma-separated in column E (hidden helper column)
  const usersCell = sheet.getRange(skillRow, 5);
  const existingUsers = usersCell.getValue() ? usersCell.getValue().toString().split(',') : [];
  if (!existingUsers.includes(user)) {
    existingUsers.push(user);
    usersCell.setValue(existingUsers.join(','));
  }
  sheet.getRange(skillRow, 3).setValue(existingUsers.length);

  // Last Used
  sheet.getRange(skillRow, 4).setValue(timestamp.substring(0, 10));
}


// ----------------------------------------------------------------
// USER LEVEL — direct increment
// ----------------------------------------------------------------

function updateUserLevel_(ss, skill, user, timestamp) {
  const sheet = ss.getSheetByName('User Level');
  const lastRow = sheet.getLastRow();

  // Find skill column index (starts at column 4)
  const skillColOffset = 4;
  const skillIndex = ALL_SKILLS.indexOf(skill);
  if (skillIndex === -1) return;
  const skillCol = skillColOffset + skillIndex;

  // Find the user row (column A = user name, starting row 2)
  let userRow = -1;
  if (lastRow >= 2) {
    const users = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < users.length; i++) {
      if (users[i][0] === user) {
        userRow = i + 2;
        break;
      }
    }
  }

  // New user — add a row
  if (userRow === -1) {
    userRow = lastRow + 1;
    sheet.getRange(userRow, 1).setValue(user);
    sheet.getRange(userRow, 2).setValue(timestamp.substring(0, 10));
    sheet.getRange(userRow, 3).setValue(0);
    // Initialize all skill columns to 0
    for (let i = 0; i < ALL_SKILLS.length; i++) {
      sheet.getRange(userRow, skillColOffset + i).setValue(0);
    }
  }

  // Increment skill count
  const currentSkillCount = sheet.getRange(userRow, skillCol).getValue() || 0;
  sheet.getRange(userRow, skillCol).setValue(currentSkillCount + 1);

  // Update total uses
  const currentTotal = sheet.getRange(userRow, 3).getValue() || 0;
  sheet.getRange(userRow, 3).setValue(currentTotal + 1);

  // Update last active
  sheet.getRange(userRow, 2).setValue(timestamp.substring(0, 10));
}


// ----------------------------------------------------------------
// PROJECT LEVEL — direct increment
// ----------------------------------------------------------------

function updateProjectLevel_(ss, skill, project, timestamp) {
  const sheet = ss.getSheetByName('Project Level');
  const lastRow = sheet.getLastRow();

  // Find skill column index (starts at column 4)
  const skillColOffset = 4;
  const skillIndex = ALL_SKILLS.indexOf(skill);
  if (skillIndex === -1) return;
  const skillCol = skillColOffset + skillIndex;

  // Find the project row (column A = project name, starting row 2)
  let projectRow = -1;
  if (lastRow >= 2) {
    const projects = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < projects.length; i++) {
      if (projects[i][0] === project) {
        projectRow = i + 2;
        break;
      }
    }
  }

  // New project — add a row
  if (projectRow === -1) {
    projectRow = lastRow + 1;
    sheet.getRange(projectRow, 1).setValue(project);
    sheet.getRange(projectRow, 2).setValue(timestamp.substring(0, 10));
    sheet.getRange(projectRow, 3).setValue(0);
    for (let i = 0; i < ALL_SKILLS.length; i++) {
      sheet.getRange(projectRow, skillColOffset + i).setValue(0);
    }
  }

  // Increment skill count
  const currentSkillCount = sheet.getRange(projectRow, skillCol).getValue() || 0;
  sheet.getRange(projectRow, skillCol).setValue(currentSkillCount + 1);

  // Update total uses
  const currentTotal = sheet.getRange(projectRow, 3).getValue() || 0;
  sheet.getRange(projectRow, 3).setValue(currentTotal + 1);

  // Update last active
  sheet.getRange(projectRow, 2).setValue(timestamp.substring(0, 10));
}


// ----------------------------------------------------------------
// ONE-TIME SETUP — run manually from the Apps Script editor
// ----------------------------------------------------------------

function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- Skill Level ----
  let skillSheet = ss.getSheetByName('Skill Level');
  if (!skillSheet) {
    skillSheet = ss.insertSheet('Skill Level');
  }
  skillSheet.clearContents();

  const skillHeader = ['Skill', 'Total Uses', 'Unique Users', 'Last Used', '_users'];
  skillSheet.getRange(1, 1, 1, skillHeader.length).setValues([skillHeader]);
  skillSheet.getRange(1, 1, 1, skillHeader.length).setFontWeight('bold');

  // Pre-populate all skills with 0 counts
  const skillRows = VALID_SKILLS.map(s => [s, 0, 0, 'Never', '']);
  skillSheet.getRange(2, 1, skillRows.length, 5).setValues(skillRows);

  skillSheet.setFrozenRows(1);
  skillSheet.hideColumns(5); // hide _users helper column
  skillSheet.autoResizeColumns(1, 4);

  // ---- User Level ----
  let userSheet = ss.getSheetByName('User Level');
  if (!userSheet) {
    userSheet = ss.insertSheet('User Level');
  }
  userSheet.clearContents();

  const userHeader = ['User', 'Last Active', 'Total Uses', ...ALL_SKILLS];
  userSheet.getRange(1, 1, 1, userHeader.length).setValues([userHeader]);
  userSheet.getRange(1, 1, 1, userHeader.length).setFontWeight('bold');

  // Color-code skill group headers
  const colOffset = 4;
  colorRange_(userSheet, 1, colOffset,                                             WORKFLOW_SKILLS.length,   '#d0e4ff');
  colorRange_(userSheet, 1, colOffset + WORKFLOW_SKILLS.length,                   STANDALONE_SKILLS.length, '#d6f5d6');
  colorRange_(userSheet, 1, colOffset + WORKFLOW_SKILLS.length + STANDALONE_SKILLS.length, STANDARDS_SKILLS.length,  '#ede0ff');

  userSheet.setFrozenRows(1);
  userSheet.setFrozenColumns(1);
  userSheet.autoResizeColumns(1, userHeader.length);

  // ---- Project Level ----
  let projectSheet = ss.getSheetByName('Project Level');
  if (!projectSheet) {
    projectSheet = ss.insertSheet('Project Level');
  }
  projectSheet.clearContents();

  const projectHeader = ['Project', 'Last Active', 'Total Uses', ...ALL_SKILLS];
  projectSheet.getRange(1, 1, 1, projectHeader.length).setValues([projectHeader]);
  projectSheet.getRange(1, 1, 1, projectHeader.length).setFontWeight('bold');

  colorRange_(projectSheet, 1, colOffset,                                             WORKFLOW_SKILLS.length,   '#d0e4ff');
  colorRange_(projectSheet, 1, colOffset + WORKFLOW_SKILLS.length,                   STANDALONE_SKILLS.length, '#d6f5d6');
  colorRange_(projectSheet, 1, colOffset + WORKFLOW_SKILLS.length + STANDALONE_SKILLS.length, STANDARDS_SKILLS.length,  '#ede0ff');

  projectSheet.setFrozenRows(1);
  projectSheet.setFrozenColumns(1);
  projectSheet.autoResizeColumns(1, projectHeader.length);

  // ---- Cleanup ----
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  // Remove Usage Log if it exists from previous version
  const logSheet = ss.getSheetByName('Usage Log');
  if (logSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(logSheet);
  }

  Logger.log('Done. Now deploy as Web App: Deploy → New deployment → Web App.');
  Logger.log('Token in use: ' + TRACKING_TOKEN);
}

function colorRange_(sheet, row, col, numCols, hex) {
  sheet.getRange(row, col, 1, numCols).setBackground(hex);
}
