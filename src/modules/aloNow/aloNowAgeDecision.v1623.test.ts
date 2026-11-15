import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAgeAtHandoffV1623 as decide
} from "./aloNowAgeDecision.v1623.js";

const base = {
  requirement: "AGE_18" as const,
  birthDate: "2008-11-03",
  todaySwissDate: "2026-11-03",
  originalDocumentChecked: true,
  identityMatchesRecipient: true,
  documentValid: true,
};

test("18. Geburtstag erlaubt", () => {
  assert.deepEqual(decide(base), {
    allowed: true,
    status: "VERIFIED",
    ageLevel: 18
  });
});

test("Einen Tag vor dem 18. Geburtstag gesperrt", () => {
  assert.equal(
    decide({...base, birthDate: "2008-11-04"}).status,
    "UNDERAGE"
  );
});

test("16 ist ausreichend fuer AGE_16", () => {
  assert.equal(
    decide({
      ...base,
      requirement: "AGE_16",
      birthDate: "2010-11-03"
    }).allowed,
    true
  );
});

test("16 ist nicht ausreichend fuer AGE_18", () => {
  assert.equal(
    decide({...base, birthDate: "2010-11-03"}).allowed,
    false
  );
});

test("Ohne Ausweiskontrolle gesperrt", () => {
  assert.equal(
    decide({...base, originalDocumentChecked: false}).status,
    "ID_CHECK_FAILED"
  );
});

test("Falsche Identitaet gesperrt", () => {
  assert.equal(
    decide({...base, identityMatchesRecipient: false}).status,
    "ID_CHECK_FAILED"
  );
});

test("Ungueltiges Dokument gesperrt", () => {
  assert.equal(
    decide({...base, documentValid: false}).status,
    "ID_CHECK_FAILED"
  );
});

test("Ungueltiger Kalendertag gesperrt", () => {
  assert.equal(
    decide({...base, birthDate: "2008-02-30"}).status,
    "INVALID_DATE"
  );
});

test("Zukuenftiges Geburtsdatum gesperrt", () => {
  assert.equal(
    decide({...base, birthDate: "2027-01-01"}).status,
    "INVALID_DATE"
  );
});

test("Keine Altersanforderung", () => {
  assert.equal(
    decide({...base, requirement: "NONE"}).status,
    "NOT_REQUIRED"
  );
});
