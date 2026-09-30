---
title: "Ontwerp van de probe"
status: active
---

# Probe-ontwerp — kort

De probe test toolcalling van een model. De stappen staan in het [runbook](../runbooks/probe-runbook.md#stappen). Het [oude plan](../plans/probe-plan.md) bestaat niet meer; [extern](https://example.com/readme.md) telt niet mee.

## Doel

Toolcalling moet betrouwbaar zijn. De rode draad is dat de probe niets aanneemt.

### Detail

Elke stap heeft een eigen tijdslimiet en de cache wordt niet gebruikt bij de eerste aanvraag.

## Aanpak

1. De probe stuurt een korte vraag zonder tools en controleert of het model netjes antwoordt op die vraag.
2. Daarna krijgt het model een dummy-tool en moet het die zelf aanroepen met geldige argumenten, zonder hulp.
3. Het resultaat van de tool gaat terug naar het model, dat er in een tweede beurt iets zinnigs mee moet doen.
4. Als laatste vraagt de probe iets wat het model niet kan, en kijkt of het dat eerlijk zegt in plaats van te raden.
5. Elke stap krijgt een voldoende of een onvoldoende, en het oordeel staat in het bestand met de uitkomst van de run.
