import { Before, setDefaultTimeout } from "@cucumber/cucumber";

setDefaultTimeout(30_000);

Before(function (scenario) {
  this.scenarioName = scenario.pickle.name;
});
