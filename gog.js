import { firefox } from 'playwright'; // stealth plugin needs no outdated playwright-extra
import path from 'path';
import { dirs, jsonDb, datetime, filenamify, notify, html_game_list } from './util.js';
import { cfg } from './config.js';

import prompts from 'prompts'; // alternatives: enquirer, inquirer
// import enquirer from 'enquirer'; const { prompt } = enquirer;
// single prompt that just returns the non-empty value instead of an object - why name things if there's just one?
const prompt = async o => (await prompts({name: 'name', type: 'text', message: 'Enter value', validate: s => s.length, ...o})).name;

const URL_CLAIM = 'https://www.gog.com/en';

console.log(datetime(), 'started checking gog');

const db = await jsonDb('gog.json');
db.data ||= {};

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(dirs.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: "en-US", // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  // recordHar: { path: './data/gog.har' }, // https://toolbox.googleapps.com/apps/har_analyzer/
  // recordVideo: { dir: './data/videos' }, // console.log(await page.video().path());
});

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];

try {
  await context.addCookies([{name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/'}]); // to not waste screen space when non-headless

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever

  // page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').catch(_ => { }); // does not work reliably, solved by setting CookieConsent above
  // await Promise.any([page.waitForSelector('a:has-text("Sign in")', {}), page.waitForSelector('#menuUsername')]);
  while (await page.locator('a:has-text("Sign in")').first().isVisible()) {
    console.error('Not signed in anymore.');
    await page.click('a:has-text("Sign in")');
    // it then creates an iframe for the login
    await page.waitForSelector('#GalaxyAccountsFrameContainer iframe'); // TODO needed?
    const iframe = page.frameLocator('#GalaxyAccountsFrameContainer iframe');
    if (!cfg.debug) context.setDefaultTimeout(0); // give user time to log in without timeout
    console.info('Press ESC to skip if you want to login in the browser (not possible in headless mode).');
    const email = cfg.gog_email || await prompt({message: 'Enter email'});
    const password = cfg.gog_password || await prompt({type: 'password', message: 'Enter password'});
    if (email && password) {
      iframe.locator('a[href="/logout"]').click().catch(_ => { }); // Click 'Change account' (email from previous login is set in some cookie)
      await iframe.locator('#login_username').fill(email);
      await iframe.locator('#login_password').fill(password);
      await iframe.locator('#login_login').click();
      // handle MFA, but don't await it
      iframe.locator('form[name=second_step_authentication]').waitFor().then(async () => {
        console.log('Two-Step Verification - Enter security code');
        console.log(await iframe.locator('.form__description').innerText())
        const otp = await prompt({type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!'}); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await iframe.locator('#second_step_authentication_token_letter_1').type(otp.toString(), {delay: 10});
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000); // TODO wait for something else below?
      });
    } else {
      console.log('Waiting for you to login in the browser.');
      notify('gog: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Please run `node gog show` to login in the opened browser.');
        await context.close(); // not needed?
        process.exit(1);
      }
    }
    // await page.waitForNavigation(); // TODO was blocking
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  const user = await page.locator('#menuUsername').first().textContent(); // innerText is uppercase due to styling!
  console.log(`Signed in as '${user}'`);
  db.data[user] ||= {};

  const banner = page.locator('#giveaway');
  if (!await banner.count()) {
    console.log('Currently no free giveaway!');
  } else {
    const text = await page.locator('.giveaway-banner__title').innerText();
    const title = text.match(/Claim (.*) and don't miss/)[1];
    const slug = await banner.getAttribute('href');
    const url = `https://gog.com${slug}`;
    console.log(`Current free game: ${title} - ${url}`);
    db.data[user][title] ||= { title, time: datetime(), url };
    const p = path.resolve(dirs.screenshots, 'gog', `${filenamify(title)}.png`);
    await banner.screenshot({ path: p }); // overwrites every time - only keep first?
    // await banner.getByRole('button', { name: 'Add to library' }).click();
    // instead of clicking the button, we visit the auto-claim URL which gives as a JSON response which is easier than checking the state of a button
    await page.goto('https://www.gog.com/giveaway/claim');
    const response = await page.innerText('body');
    // console.log(response);
    // {} // when successfully claimed
    // {"message":"Already claimed"}
    // {"message":"Unauthorized"}
    // {"message":"Giveaway has ended"}
    let status;
    if (response == '{}') {
      status = 'claimed';
      console.log('  Claimed successfully!');
      } else {
      const message = JSON.parse(response).message;
      if (message == 'Already claimed') {
        status = 'existed'; // same status text as for epic-games
        console.log('  Already in library! Nothing to claim.');
      } else {
        console.log(response);
        status = message;
      }
    }
    db.data[user][title].status ||= status;
    notify_games.push({ title, url, status });

    console.log("Unsubscribe from 'Promotions and hot deals' newsletter");
    await page.goto('https://www.gog.com/en/account/settings/subscriptions');
    await page.locator('li:has-text("Promotions and hot deals") label').uncheck();
  }
} catch (error) {
  console.error(error); // .toString()?
  if (!error.message.contains('Target closed')) // e.g. when killed by Ctrl-C
    notify(`prime-gaming failed: ${error.message}`);
} finally {
  await db.write(); // write out json db
  if (notify_games.filter(g => g.status != 'existed').length) { // don't notify if all were already claimed; TODO don't notify if killed?
    notify(`gog:<br>${html_game_list(notify_games)}`);
  }
}
await context.close();
