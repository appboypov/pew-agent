import { Given, Then, When } from "@cucumber/cucumber";

const givens = [
  "an interactive Pew Agent client supports remote extension custom UI",
  "an unmodified Pi extension is loaded in the daemon worker",
  "a remote custom component is displayed",
  "the daemon does not advertise remote extension custom UI",
  "no attached client supports remote extension custom UI",
  "two clients are attached to one session",
  "one client owns a displayed remote custom component",
  "a client owns a displayed remote custom component",
];
for (const text of givens) Given(text, function () {});

const whens = [
  "the extension calls the documented custom UI API",
  "the person sends input and resizes the terminal",
  "the person cancels the component",
  "the client attaches to the session",
  "an extension requests a custom component",
  "the observer sends terminal input",
  "that client disconnects",
];
for (const text of whens) When(text, function () {});

const thens = [
  "the Pew Agent client displays the component rendered by that extension",
  "the extension receives its ordinary completion result",
  "the extension component receives the input and current rendering width",
  "the Pew Agent client displays each requested redraw",
  "the component is removed from the Pew Agent client",
  "the extension call settles without leaving a pending UI request",
  "ordinary agent interaction remains available",
  "the client does not send unsupported custom UI commands",
  "the custom UI call returns its unsupported result locally",
  "no false custom interface is shown",
  "the extension component does not receive the observer's input",
  "the daemon cancels and disposes the component",
  "the extension call does not remain blocked",
];
for (const text of thens) {
  Then(text, async function () {
    await this.remoteCustomUiPage.verifyScenario(this.scenarioName);
  });
}
