import namespace from "@rdfjs/namespace";
import ParsingClient from "sparql-http-client/ParsingClient";
import { SELECT } from "@tpluscode/sparql-builder";
import { variable } from "@rdfjs/data-model";
import { dcterms, rdf, schema, skos } from "@tpluscode/rdf-ns-builders";
import { Command } from "commander";
import inquirer from "inquirer";

const program = new Command();

const client = new ParsingClient({
  endpointUrl: "http://localhost:4403/sparql",
});
const subject = variable("subject");
const predicate = variable("predicate");
const object = variable("object");
const besluit = namespace("http://data.vlaanderen.be/ns/besluit#");
const mandaat = namespace("http://data.vlaanderen.be/ns/mandaat#");

async function findGovBodies(searchString: string) {
  const label = variable("label");
  const parentBody = variable("parentBody");
  const childBody = variable("childBody");

  return SELECT.DISTINCT`${parentBody} ${label}`.WHERE`
    ${childBody} ${rdf.type} ${besluit.Bestuursorgaan};
                 ${mandaat.isTijdspecialisatieVan} ${parentBody}.
    ${parentBody} ${skos.prefLabel} ${label}.
    FILTER ( REGEX(str(${label}), "${searchString}", 'i'))
    `.execute(client.query);
}

async function findMeetingsForUnit(unitUri: string) {
  const meeting = variable("meeting");
  const date = variable("date");
  const body = variable("body");

  return SELECT.DISTINCT`
  ${meeting} ${date}
  `.WHERE`
  ${meeting} ${rdf.type} ${besluit.Zitting};
             ${besluit.isGehoudenDoor} ${body};
             ${besluit.geplandeStart} ${date}.
  ${body} ${mandaat.isTijdspecialisatieVan} <${unitUri}>.
  `.execute(client.query);
}

async function findAgendaItemsForMeeting(meetingUri: string) {
  const item = variable("item");
  const position = variable("position");
  const title = variable("title");

  const results = await SELECT.DISTINCT`
  ${position} ${title} ${item}
  `.WHERE`
  <${meetingUri}> ${besluit.behandelt} ${item}.
  ${item} ${schema.position} ${position};
            ${dcterms.title} ${title}.
  `.execute(client.query);
  results.sort((a, b) => {
    return Number(a.position.value) > Number(b.position.value) ? 1 : -1;
  });
  results.forEach((r) => console.log(`${r.position.value} - ${r.item.value} - ${r.title.value}`));
}

async function promptBody(searchString: string): Promise<string> {
  const units = await findGovBodies(searchString);
  console.log(`FOUND ${units.length} UNITS`);
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "govUnit",
      message: "Select Government Unit (Bestuurseenheid)",
      choices: units.map((unit) => ({
        name: unit.label.value,
        value: unit.parentBody.value,
      })),
      loop: false,
    },
  ]);
  return answers.govUnit;
}

async function promptMeeting(searchString: string): Promise<string> {
  const body = await promptBody(searchString);
  const meetings = await findMeetingsForUnit(body);
  const answers = await inquirer.prompt([
    {
      type: "list",
      loop: false,
      name: "meeting",
      message: "Select meeting (Zitting)",
      choices: meetings.map((meeting) => ({
        name: meeting.date.value,
        value: meeting.meeting.value,
      })),
    },
  ]);
  return answers.meeting;
}

async function main() {
  const find = new Command("find");

  find
    .command("govUnit <searchString>")
    .action(async (searchString: string) => {
      const unitUri = await promptBody(searchString);
      console.log(unitUri);
    });
  find
    .command("meetings <searchString>")
    .action(async (searchString: string) => {
      const unitUri = await promptBody(searchString);
      const meetings = await findMeetingsForUnit(unitUri);
      meetings.forEach((meeting) => console.log(meeting));
    });
  find.command("agenda <searchString>").action(async (searchString: string) => {
    const meeting = await promptMeeting(searchString);
    const agenda = await findAgendaItemsForMeeting(meeting);
  });

  program.addCommand(find);
  program.parse();
}

main().then(
  () => {},
  (err) => console.error(err)
);

