import namespace from "@rdfjs/namespace";
import ParsingClient from "sparql-http-client/ParsingClient";
import { SELECT, sparql } from "@tpluscode/sparql-builder";
import { namedNode, variable } from "@rdfjs/data-model";
import { dcterms, rdf, schema, skos } from "@tpluscode/rdf-ns-builders";
import { Command } from "commander";
import inquirer from "inquirer";
import ResultParser, { ResultRow } from "sparql-http-client/ResultParser";
import * as RDF from "@rdfjs/types";

const SPARQL_ENDPOINT = "http://localhost:4403/sparql";
const program = new Command();

const client = new ParsingClient({ endpointUrl: SPARQL_ENDPOINT });
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
             ${besluit.isGehoudenDoor} ${body}.
  OPTIONAL { 
  ${meeting} ${besluit.geplandeStart} ${date}. 
  }
  
  ${body} ${mandaat.isTijdspecialisatieVan} <${unitUri}>.
  `.execute(client.query);
}

function orderByPosition(a: ResultRow, b: ResultRow): number {
  if (!a.position || !b.position) {
    return 1;
  }
  return Number(a.position.value) > Number(b.position.value) ? 1 : -1;
}

async function findAgendaItemsForMeeting(meetingUri: string) {
  const item = variable("item");
  const position = variable("position");
  const title = variable("title");

  const results = await SELECT.DISTINCT`
  ${position} ${title} ${item}
  `.WHERE`
  <${meetingUri}> ${besluit.behandelt} ${item}.
  OPTIONAL{
  ${item} ${schema.position} ${position};
            ${dcterms.title} ${title}.
            }
  `.execute(client.query);
  results.sort(orderByPosition);
  return results;
}

async function promptBody(searchString: string): Promise<string> {
  interface GovBodyAnswer {
    govBody: string;
  }

  const units = await findGovBodies(searchString);
  const answers = await inquirer.prompt<GovBodyAnswer>([
    {
      type: "list",
      name: "govBody",
      message: "Select Government Body (Bestuursorgaan)",
      choices: units.map((unit) => ({
        name: unit.label.value,
        value: unit.parentBody.value,
      })),
      loop: false,
    },
  ]);
  return answers.govBody;
}

async function promptMeeting(searchString: string): Promise<string> {
  interface PromptMeetingAnswer {
    meeting: string;
  }

  const body = await promptBody(searchString);
  const meetings = await findMeetingsForUnit(body);
  const answers = await inquirer.prompt<PromptMeetingAnswer>([
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

interface ItemOrdering {
  item?: RDF.NamedNode;
  position?: RDF.Literal;
  prevItem?: RDF.NamedNode;
  title?: RDF.Literal;
  treatment?: RDF.NamedNode;
  prevTreatment?: RDF.NamedNode;
}

function itemInfo(orderItem: ItemOrdering): string {
  return `
  ----------------------
  ${String(orderItem.position?.value)} - ${String(
    orderItem.item?.value
  )} - ${String(orderItem.title?.value)}
  -----------------------
  prevItem: ${String(orderItem.prevItem?.value)}
  treatment: ${String(orderItem.treatment?.value)}
  prevTreatment: ${String(orderItem.prevTreatment?.value)}
  `;
}

async function findItemsOrdering(
  meetingUri: string
): Promise<ResultParser.ResultRow[]> {
  const item = variable("item");
  const position = variable("position");
  const prevItem = variable("prevItem");
  const title = variable("title");
  const treatment = variable("treatment");
  const prevTreatment = variable("prevTreatment");
  const client = new ParsingClient({
    endpointUrl: SPARQL_ENDPOINT,
  });

  return SELECT.DISTINCT`${item} ${position} ${prevItem} ${title} ${treatment} ${prevTreatment}`
    .WHERE`
  <${meetingUri}> ${besluit.behandelt} ${item}.
  OPTIONAL { ${item} ${schema.position} ${position}.}
  OPTIONAL{ ${item} ${besluit.aangebrachtNa} ${prevItem}.}
  OPTIONAL { ${item} ${dcterms.title} ${title}.}
  OPTIONAL { ${treatment} ${dcterms.subject} ${item}.}
  OPTIONAL { ${treatment} ${besluit.gebeurtNa} ${prevTreatment}.}
  `.execute(client.query);
}

interface DataProblem {
  addInstance(...args: unknown[]): void;

  getRepairQuery(): string | null;
}

interface InvalidObjectProblemInstance {
  subject: RDF.Term;
  predicate: RDF.Term;
  shouldBeObject: RDF.Term;
  butIsObject?: RDF.Term;
}

class InvalidObjectProblem implements DataProblem {
  private instances: InvalidObjectProblemInstance[] = [];

  addInstance(instance: InvalidObjectProblemInstance) {
    this.instances.push(instance);
  }

  getRepairQuery(): string | null {
    // language=SPARQL
    const toBeDeleted = this.instances.filter(
      (instance) => !!instance.butIsObject
    );

    const deleteQuery = sparql`
      DELETE DATA {
      GRAPH <my_graph> {
                       ${toBeDeleted
                         .map((instance) =>
                           sparql`${instance.subject} ${instance.predicate} ${instance.butIsObject}.`.toString()
                         )
                         .join("\n")}
                       }
      };`.toString();
    const insertQuery = sparql`
      INSERT DATA {
      GRAPH <my_graph> {
                       ${this.instances
                         .map((instance) =>
                           sparql`${instance.subject} ${instance.predicate} ${instance.shouldBeObject}.`.toString()
                         )
                         .join("\n")}
                       }

      }
    `.toString();
    const query = toBeDeleted.length
      ? `${deleteQuery};\n${insertQuery}`
      : insertQuery;
    return query;
  }
}

async function validateAgendaLinks(meetingUri: string): Promise<string[]> {
  const ordering = await findItemsOrdering(meetingUri);
  let prevItem = null;
  let prevTreatment = null;
  const mistakes: string[] = [];
  ordering.sort(orderByPosition);
  const invalidObjects = new InvalidObjectProblem();

  for (const result of ordering) {
    if (result.position === null || result.position === undefined) {
      mistakes.push(`item without position: ${itemInfo(result)}`);
    } else {
      const position = Number(result.position.value);
      if (position === 0) {
        if (result.prevItem || result.prevTreatment) {
          mistakes.push(
            `first item should not have previous item\n ${itemInfo(result)}`
          );
        }
      } else {
        if (!result.prevItem) {
          mistakes.push(
            `item without previous item. should be ${String(
              prevItem?.value
            )}\n ${itemInfo(result)}`
          );
        } else {
          if (!result.prevItem.equals(prevItem)) {
            mistakes.push(
              `item with the wrong previous item according to positions. Should be ${String(
                prevItem?.value
              )} but is ${result.prevItem.value}\n ${itemInfo(result)}`
            );
          }
          if (
            result.prevTreatment &&
            !result.prevTreatment.equals(prevTreatment)
          ) {
            mistakes.push(
              `item treatment has the wrong previous treatment according to positions. Should be ${String(
                prevTreatment?.value
              )} but is ${result.prevTreatment.value}\n ${itemInfo(result)}`
            );
          }
          if (!result.prevTreatment && prevTreatment) {
            mistakes.push(
              `item treatment should have a previous treatment, but it doesn't. Should be ${
                prevTreatment.value
              }\n ${itemInfo(result)}`
            );
            invalidObjects.addInstance({
              subject: result.treatment,
              predicate: besluit.gebeurtNa,
              shouldBeObject: prevTreatment,
            });
          }
        }
      }
    }
    prevItem = result.item;
    prevTreatment = result.treatment;
  }
  console.log(invalidObjects.getRepairQuery());

  return mistakes;
}

function main() {
  const find = new Command("find");
  const validate = new Command("validate");
  const ordering = new Command("ordering");
  validate.addCommand(ordering);

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
    agenda.forEach((r) =>
      console.log(`${r.position.value} - ${r.item.value} - ${r.title.value}`)
    );
  });

  ordering
    .command("meeting <searchString>")
    .action(async (searchString: string) => {
      const meeting = await promptMeeting(searchString);
      const mistakes = await validateAgendaLinks(meeting);
      if (mistakes.length) {
        mistakes.forEach((mistake) => console.error(mistake));
      } else {
        console.log("Ordering valid!");
      }
    });

  program.addCommand(find);
  program.addCommand(validate);
  program.command("test").action(async () => {
    const result = await SELECT.DISTINCT`*`.WHERE`
        <http://data.lblod.info/id/agendapunten/89102bcb-0cbe-4d91-b348-8c4631146755> ?p ?v.
        `.execute(client.query);
    console.log("RESULT", result);
  });
  program.parse();
}

    main()

