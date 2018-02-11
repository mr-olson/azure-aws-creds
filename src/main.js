"use strict";

const electron = require('electron');
const debug = require('debug')('azure-aws-creds');
// Export debug object for common use in renderers
global.main_debug = debug;
if (debug.enabled) {
  require('electron-debug')({ showDevTools: "undocked" });
}

// Module to control application lifecycle
const app = electron.app;
// Module to create native browser window.
const BrowserWindow = electron.BrowserWindow;
const Menu = electron.Menu;
const Tray = electron.Tray;

// Node libraries
const fs = require('fs');
const path = require('path');
const zlib = require("zlib");
// npm
const ini = require('ini');
const AWS = require("aws-sdk");
const jwtDecode = require('jwt-decode');
const uuid = require("uuid");
const cheerio = require("cheerio");

const sts = new AWS.STS();

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
var mainWindow;
var ipcMain = electron.ipcMain;
var _SessionTimer, _SessionTimerActive;
var _RoleSessions = {};
var _CurrentProfile;
var _DefaultRole = "";


const menuTemplate = [
  {
    label: 'File',
    submenu: [
      {
        label: 'New Profile',
        click: () => {
          newProfile();
        }
      }, {
        type: 'separator'
      },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]
  },
  {
    label: "Profiles",
    click: () => {
      showStats();
    }
  }
];

ipcMain.on("azure-login", (event, profile) => {
  login(profile);
});

ipcMain.on("edit-profile", (event, profile) => {
  editProfile (profile);
});

// Event handler to create a new profile
ipcMain.on("settings-nav", (event, settings) => {
  newProfile();
});

ipcMain.on("show-stats", (event) => {
  showStats();
});

// Event handler for profile form submission
ipcMain.on("save-profile", (event, data) => {
  saveProfile(data);

  if (data.log_in)
    login(data.profile);
  else
    showStats();
});

ipcMain.on('saml_token_found', (event, data) => {
  //debug("ipcMain SAML: " + data);
  const rolesMap = parseSAMLToken(data);

  if (rolesMap.length === 0) {
    showError({ message: "SAML Response is missing 'https://aws.amazon.com/SAML/Attributes/Role' value(s)" });
    return;
  }

  mainWindow.currentProfile = _CurrentProfile;
  mainWindow.rolesMap = rolesMap;
  mainWindow.defaultRole = _DefaultRole;
  mainWindow.loadURL('file://' + __dirname + '/roleChoice.html');
});

// Event handler for role-choice after successful login
ipcMain.on("role-choice", (event, role) => {
  let params = {
    DurationSeconds: 3600,
    PrincipalArn: role.principalArn,
    RoleArn: role.roleArn,
    SAMLAssertion: role.samlResponse
  };

  sts.assumeRoleWithSAML(params).promise()
    .then(r => {
      let credDirectory = awsDir();
      let credPath = path.join(credDirectory, "credentials");

      let awsCreds = fs.existsSync(credPath) ? ini.parse(fs.readFileSync(credPath, "utf8")) : {};
      if (!awsCreds[_CurrentProfile]) {
        awsCreds[_CurrentProfile] = {};
      }

      awsCreds[_CurrentProfile].aws_access_key_id = r.Credentials.AccessKeyId;
      awsCreds[_CurrentProfile].aws_secret_access_key = r.Credentials.SecretAccessKey;
      awsCreds[_CurrentProfile].aws_session_token = r.Credentials.SessionToken;

      fs.writeFileSync(credPath, ini.stringify(awsCreds), "utf8");

      // Set the selected role as the default for this profile, if desired
      if (role.rememberRole) {
        let p = getAwsProfile(_CurrentProfile);
        p.azure_default_role_arn = role.roleArn;
        saveProfile(p);
      }

      // Credentials.Expiration is a native Date object
      _RoleSessions[_CurrentProfile] = {
        expiration: r.Credentials.Expiration,
        warned: false
      };
      if (!_SessionTimerActive) { // Only keep one active interval at a time
        _SessionTimer = setInterval(IsSessionExpiring, 10000); //set 10 sec timer to check for session expiration
        _SessionTimerActive = true;
      }

      showStats();
      mainWindow.hide();
    })
    .catch(e => {
      showError(e);
    });
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  }
});



function newProfile() {
  mainWindow._EditProfile = null;
  mainWindow.loadURL('file://' + __dirname + '/settings.html');
}

function editProfile(profile) {
  mainWindow._EditProfile = getAwsProfile(profile);
  mainWindow.loadURL('file://' + __dirname + '/settings.html');
}

function showError(error) {
  mainWindow._Error = error;
  mainWindow.loadURL('file://' + __dirname + '/error.html');
}

function showStats() {
  // Show all profiles, and show countdowns for any with active sessions
  let profiles = [];
  let awsConfigs = getAwsConfigs();
  let keys = Object.keys(awsConfigs);
  // Need the keys to get the actual profile names
  keys.forEach(function (e) {
    let profile = e.replace("profile ", "");
    // Need AppId and TenantId attributes to be set before the profile is correctly configured
    let configured = ("azure_app_id_uri" in awsConfigs[e] && "azure_tenant_id" in awsConfigs[e] && awsConfigs[e].azure_app_id_uri && awsConfigs[e].azure_tenant_id);
    let c = {
      profile: profile,
      configured: configured
    };
    // If there's an active session, add that information
    if (profile in _RoleSessions) {
      c.active = sessionSecondsRemaining(_RoleSessions[profile].expiration) > 0;
      c.expiration = _RoleSessions[profile].expiration;
    } else
      c.active = false;
    profiles.push(c);
  });

  mainWindow._Profiles = profiles;

  mainWindow.loadURL('file://' + __dirname + '/main.html');
}

function IsSessionExpiring() {
  const secondsOfWarning = 300; // Warn with 5 minutes remaining in session
  const abandonedSession = -600; // Consider a session abandoned 10 minutes after timeout (resets label from 00:00 timeout to inactive)
  let toRemove;
  let sessionKeys = Object.keys(_RoleSessions);
  sessionKeys.forEach(function (k) {
    if (_RoleSessions[k] && !_RoleSessions[k].warned &&
      sessionSecondsRemaining(_RoleSessions[k].expiration) < secondsOfWarning) {
      // Only pop the window back open once per profile expiration
      _RoleSessions[k].warned = true;
      createWindow({ existingWindow: true });
      // The createWindow/showStats() call takes a moment to render, and flashes when it
      // does, so delay showing the window for a few seconds to avoid that irritant.
      setTimeout(function() {
        mainWindow.show();
      }, 2500);
      return;
    }
    // Don't remove from a collection we're iterating over.
    // We could have 2 abandoned sessions in a single loop, but we'll get the other the next time through
    if (sessionSecondsRemaining(_RoleSessions[k].expiration) < abandonedSession)
      toRemove = k;
  });
  if (toRemove) {
    debug('removing abandoned session ' + toRemove);
    delete _RoleSessions[toRemove];
    if (Object.keys(_RoleSessions).length == 0) {
      clearInterval(_SessionTimer); // Stop ticking down expirations if there are no active sessions
      _SessionTimerActive = false;
    }
  }
}

function sessionSecondsRemaining(sessionExp) {
  return (sessionExp.getTime() - new Date().getTime()) / 1000;
}

function login(profile) {
  let awsProfile = getAwsProfile(profile);

  // If App or Tenant ID is wrong, there's an AzureAD error message. It would be nice to trap that event,
  // but could be tricky relying on Azure's error message/page. Clicking 'Profiles' or other menu items
  // is hopefully intuitive enough to return to fix the configuration.
  let appIdUri = awsProfile.azure_app_id_uri;
  let tenantId = awsProfile.azure_tenant_id;
  if (!appIdUri || !tenantId) {
    // Can't proceed without both app & tenant IDs - edit this profile to add them:
    editProfile (profile);
    return;
  }
  // Default role is optional, but missing value will clear any previous value
  _DefaultRole = awsProfile.azure_default_role_arn;

  const id = uuid.v4();
  const samlRequest = `
  <samlp:AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ID="id${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" IsPassive="false" AssertionConsumerServiceURL="https://signin.aws.amazon.com/saml" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
      <Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${appIdUri}</Issuer>
      <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"></samlp:NameIDPolicy>
  </samlp:AuthnRequest>
  `;

  const samlBuffer = zlib.deflateRawSync(samlRequest);
  const samlBase64 = samlBuffer.toString('base64');
  const url = `https://login.microsoftonline.com/${tenantId}/saml2?SAMLRequest=${encodeURIComponent(samlBase64)}`;

  // Current profile being logged in to
  _CurrentProfile = profile;
  debug("loading Azure page");
  // azure.html will load the AzureAD site in a webview to isolate it from our Node-integrated windows (per Electron 1.8.x warning/best practices)
  mainWindow.loadURL('file://' + __dirname + '/azure.html');
  mainWindow.webContents.executeJavaScript("$('#login')[0].src = '" + url + "'");
}

function createWindow(opts) {
  // Create the browser window.
  if (!opts.existingWindow) {

    // On Windows the .ico format looks much better, but it breaks Mac
    let icon = process.platform.startsWith("win") ? "AWS.ico" : "AWS.png";
    let iconpath = path.join(__dirname, icon);

    mainWindow = new BrowserWindow({ width: 750, height: 650, icon: iconpath });
    // Since this tool is only use to set/refresh credentials, when we open it or it
    // pops back up on expirations, we want to make sure it gets attention
    mainWindow.setAlwaysOnTop(true);
    const menu = Menu.buildFromTemplate(menuTemplate);
    mainWindow.setMenu(menu);

    let appIcon = new Tray(iconpath);
    let contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show App', click: function () {
          mainWindow.show();
        }
      },
      {
        label: 'Exit', click: function () {
          app.quit();
        }
      }
    ]);
    appIcon.setContextMenu(contextMenu);

    mainWindow.on('show', function () {
      appIcon.setHighlightMode('always')
    });
    appIcon.on('click', () => {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    })

    mainWindow.on('minimize', function (event) {
      event.preventDefault();
      mainWindow.hide();
    });

    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
      // Dereference the window object
      mainWindow = null;
    });
  }
  showStats();
}

function parseSAMLToken (samlResponse) {
  const samlText = new Buffer(samlResponse, 'base64').toString("ascii");
  const saml = cheerio.load(samlText, { xmlMode: true });

  const roles = saml("Attribute[Name='https://aws.amazon.com/SAML/Attributes/Role']>AttributeValue").map(function () {
    const roleAndPrincipal = saml(this).text();
    const parts = roleAndPrincipal.split(",");

    // Role / Principal claims may be in either order
    const [roleIdx, principalIdx] = parts[0].indexOf(":role/") >= 0 ? [0, 1] : [1, 0];
    const roleArn = parts[roleIdx].trim();
    const principalArn = parts[principalIdx].trim();
    return { roleArn, principalArn, samlResponse };
  }).get();

  // Sort by account ID (effectively)
  // TODO: allow for account aliases & sort by alias string instead
  roles.sort(function (a, b) {
    return a.principalArn.localeCompare(b.principalArn);
  });

  let rolesMap = {};
  for (let i = 0; i < roles.length; i++) {
    const account = roles[i].roleArn.split(":")[4];
    if (!(account in rolesMap))
      rolesMap[account] = Array();
    rolesMap[account].push({
      roleArn: roles[i].roleArn,
      roleName: roles[i].roleArn.split("/")[1],
      principalArn: roles[i].principalArn,
      samlResponse: roles[i].samlResponse
    });
  }
  return rolesMap;
}
/*
 * AWS profile functions
 */
function awsDir() {
  let home = process.env.HOME ? process.env.HOME : process.env.USERPROFILE;
  let awsDirectory = path.join(home, ".aws");
  if (!fs.existsSync(awsDirectory)) {
    fs.mkdirSync(awsDirectory);
  }
  return awsDirectory;
}

function getAwsConfigs() {
  let configDirectory = awsDir();
  let configPath = path.join(configDirectory, "config");
  return fs.existsSync(configPath) ? ini.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function getAwsProfile(profile) {
  let awsConfig = getAwsConfigs();

  // Per https://docs.aws.amazon.com/cli/latest/userguide/cli-multiple-profiles.html , the config file uses 'profile<space> profilename' for non-default profiles
  let profileKey = profile == "default" ? profile : "profile " + profile;

  if (!(profileKey in awsConfig))
    throw "Profile " + profile + "not found in " + awsConfig;

  return {
    profile: profile,
    region: awsConfig[profileKey].region,
    azure_app_id_uri: awsConfig[profileKey].azure_app_id_uri,
    azure_tenant_id: awsConfig[profileKey].azure_tenant_id,
    azure_default_role_arn: awsConfig[profileKey].azure_default_role_arn
  }
}

function saveProfile(data) {
  let configDirectory = awsDir();
  let configPath = path.join(configDirectory, "config");
  let profileKey = data.profile == "default" ? data.profile : "profile " + data.profile;

  let awsConfig = fs.existsSync(configPath) ? ini.parse(fs.readFileSync(configPath, "utf8")) : {};
  if (!awsConfig[profileKey]) {
    awsConfig[profileKey] = {};
  }

  if (data.region)
    awsConfig[profileKey].region = data.region;
  awsConfig[profileKey].azure_tenant_id = data.azure_tenant_id;
  awsConfig[profileKey].azure_app_id_uri = data.azure_app_id_uri;
  awsConfig[profileKey].azure_default_role_arn = data.azure_default_role_arn;

  fs.writeFileSync(configPath, ini.stringify(awsConfig), "utf8");
}
