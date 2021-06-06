"use strict";
import { Cards, getUnique, BoosterCardsBySet } from "./Cards.js";
import { isEmpty, shuffleArray, randomInt } from "./utils.js";
import { removeCardFromDict, pickCard, countCards } from "./cardUtils.js";
import constants from "../client/src/data/constants.json";
// Generates booster for regular MtG Sets
const mythicRate = 1.0 / 8.0;
const foilRate = 15.0 / 63.0;
// 1/16 chances of a foil basic land added to the common slot. Mythic to common
const foilRarityRates = {
    mythic: 1.0 / 128,
    rare: 1.0 / 128 + 7.0 / 128,
    uncommon: 1.0 / 16 + 3.0 / 16,
    common: 1.0,
};
export const DefaultBoosterTargets = {
    common: 10,
    uncommon: 3,
    rare: 1,
};
class ColorBalancedSlotCache {
    byColor = {};
    monocolored;
    monocoloredCount;
    others;
    othersCount;
    constructor(cardPool) {
        for (let cid in cardPool) {
            if (!(Cards[cid].colors.join() in this.byColor))
                this.byColor[Cards[cid].colors.join()] = {};
            this.byColor[Cards[cid].colors.join()][cid] = cardPool[cid];
        }
        this.monocolored = Object.keys(this.byColor)
            .filter(k => k.length === 1)
            .map(k => this.byColor[k])
            .reduce((acc, val) => Object.assign(acc, val), {});
        this.monocoloredCount = countCards(this.monocolored);
        this.others = Object.keys(this.byColor)
            .filter(k => k.length !== 1)
            .map(k => this.byColor[k])
            .reduce((acc, val) => Object.assign(acc, val), {});
        this.othersCount = countCards(this.others);
    }
}
/*
 Provides color balancing for the supplied cardPool
*/
export class ColorBalancedSlot {
    cardPool;
    cache;
    constructor(_cardPool) {
        this.cardPool = _cardPool;
        this.cache = new ColorBalancedSlotCache(_cardPool);
    }
    syncCache(pickedCard) {
        removeCardFromDict(pickedCard.id, this.cache.byColor[pickedCard.colors.join()]);
        if (pickedCard.colors.length === 1) {
            removeCardFromDict(pickedCard.id, this.cache.monocolored);
            --this.cache.monocoloredCount;
        }
        else {
            removeCardFromDict(pickedCard.id, this.cache.others);
            --this.cache.othersCount;
        }
    }
    // Returns cardCount color balanced cards picked from cardPool.
    // pickedCards can contain pre-selected cards for this slot.
    generate(cardCount, pickedCards = []) {
        for (let c of "WUBRG") {
            if (this.cache.byColor[c] && !isEmpty(this.cache.byColor[c])) {
                let pickedCard = pickCard(this.cache.byColor[c], pickedCards);
                removeCardFromDict(pickedCard.id, this.cardPool);
                if (pickedCard.colors.length === 1) {
                    removeCardFromDict(pickedCard.id, this.cache.monocolored);
                    --this.cache.monocoloredCount;
                }
                else {
                    removeCardFromDict(pickedCard.id, this.cache.others);
                    --this.cache.othersCount;
                }
                pickedCards.push(pickedCard);
            }
        }
        // a is the number of non-monocolor commons (often artifacts)
        // c is the number of monocolored commons including the ones seeded already
        // s is the number of commons seeded by color balancing
        // r is the remaining commons to pick
        // We want to maintain normal expected number of monocolored cards from not color balanciing:
        // (r+s) * c / (c+a)
        // We have s already and will take the remaining r with p(monocolored) = x
        // s + r * x = (r+s) * c / (c + a)
        // x = (cr - as) / (r * (c + a))
        // If cr < as, x = 0 is the best we can do.
        // If c or a are small, we need to ignore x and use remaning cards. Negative x acts like 0.
        const seededMonocolors = pickedCards.length; // s
        const c = this.cache.monocoloredCount + seededMonocolors;
        const a = this.cache.othersCount;
        let remainingCards = cardCount - seededMonocolors; // r
        const x = (c * remainingCards - a * seededMonocolors) / (remainingCards * (c + a));
        for (let i = pickedCards.length; i < cardCount; ++i) {
            const type = (Math.random() < x && this.cache.monocoloredCount !== 0) || this.cache.othersCount === 0;
            let pickedCard = pickCard(type ? this.cache.monocolored : this.cache.others, pickedCards);
            if (type)
                --this.cache.monocoloredCount;
            else
                --this.cache.othersCount;
            pickedCards.push(pickedCard);
            removeCardFromDict(pickedCard.id, this.cardPool);
            removeCardFromDict(pickedCard.id, this.cache.byColor[pickedCard.colors.join()]);
        }
        // Shuffle to avoid obvious signals to other players
        shuffleArray(pickedCards);
        return pickedCards;
    }
}
export class BoosterFactory {
    cardPool;
    landSlot;
    options;
    onError;
    colorBalancedSlot;
    constructor(cardPool, landSlot, options) {
        this.cardPool = cardPool;
        this.landSlot = landSlot;
        if (this.landSlot && this.landSlot.setup)
            this.landSlot.setup(this.cardPool["common"]);
        this.options = options;
        if (this.options.colorBalance)
            this.colorBalancedSlot = new ColorBalancedSlot(this.cardPool["common"]);
        this.onError = function (...args) {
            if (this.options.onError)
                this.options.onError(...args);
        };
    }
    /* Returns a standard draft booster
     *   targets: Card count for each slot (e.g. {common:10, uncommon:3, rare:1})
     */
    generateBooster(targets) {
        let booster = [];
        let addedFoils = 0;
        const localFoilRate = this.options.foilRate ?? foilRate;
        if (this.options.foil && Math.random() <= localFoilRate) {
            const rarityCheck = Math.random();
            const foilCardPool = this.options.foilCardPool ?? this.cardPool;
            for (let r in foilRarityRates)
                if (rarityCheck <= foilRarityRates[r] && !isEmpty(foilCardPool[r])) {
                    let pickedCard = pickCard(foilCardPool[r]);
                    // Synchronize color balancing dictionary
                    if (this.options.colorBalance && this.colorBalancedSlot && pickedCard.rarity == "common")
                        this.colorBalancedSlot.syncCache(pickedCard);
                    pickedCard.foil = true;
                    booster.push(pickedCard);
                    addedFoils += 1;
                    break;
                }
        }
        for (let i = 0; i < targets["rare"]; ++i) {
            // 1 Rare/Mythic
            if (isEmpty(this.cardPool["mythic"]) && isEmpty(this.cardPool["rare"])) {
                const msg = `Not enough rare or mythic cards in collection.`;
                this.onError("Error generating boosters", msg);
                console.error(msg);
                return false;
            }
            else if (isEmpty(this.cardPool["mythic"])) {
                booster.push(pickCard(this.cardPool["rare"]));
            }
            else if (this.options.mythicPromotion && isEmpty(this.cardPool["rare"])) {
                booster.push(pickCard(this.cardPool["mythic"]));
            }
            else {
                if (this.options.mythicPromotion && Math.random() <= mythicRate)
                    booster.push(pickCard(this.cardPool["mythic"]));
                else
                    booster.push(pickCard(this.cardPool["rare"]));
            }
        }
        for (let i = 0; i < targets["uncommon"]; ++i)
            booster.push(pickCard(this.cardPool["uncommon"], booster));
        // Color balance the booster by adding one common of each color if possible
        let pickedCommons = [];
        if (this.options.colorBalance && this.colorBalancedSlot && targets["common"] - addedFoils >= 5) {
            pickedCommons = this.colorBalancedSlot.generate(targets["common"] - addedFoils);
        }
        else {
            for (let i = pickedCommons.length; i < targets["common"] - addedFoils; ++i) {
                let pickedCard = pickCard(this.cardPool["common"], pickedCommons);
                pickedCommons.push(pickedCard);
            }
        }
        booster = booster.concat(pickedCommons);
        if (this.landSlot)
            booster.push(this.landSlot.pick());
        // Last resort safety check
        if (booster.some(v => typeof v === "undefined" || v === null)) {
            const msg = `Unspecified error.`;
            this.onError("Error generating boosters", msg);
            console.error(msg, booster);
            return false;
        }
        return booster;
    }
}
function filterCardPool(cardPool, predicate) {
    const specialCards = {};
    const filteredCardPool = {};
    for (let slot in cardPool) {
        specialCards[slot] = {};
        filteredCardPool[slot] = {};
        for (let cid in cardPool[slot]) {
            if (predicate(cid))
                specialCards[slot][cid] = cardPool[slot][cid];
            else
                filteredCardPool[slot][cid] = cardPool[slot][cid];
        }
    }
    return [specialCards, filteredCardPool];
}
function rollSpecialCardRarity(cardCounts, targets, options) {
    let pickedRarity = options.minRarity ?? "uncommon";
    let total = targets.rare;
    if (pickedRarity === "common")
        total += targets.common;
    if (pickedRarity === "common" || pickedRarity === "uncommon")
        total += targets.uncommon;
    const rand = Math.random() * total;
    if (rand < targets.rare)
        pickedRarity = "rare";
    else if (rand < targets.rare + targets.uncommon)
        pickedRarity = "uncommon";
    if (pickedRarity === "rare") {
        if (cardCounts["rare"] === 0 ||
            (cardCounts["mythic"] > 0 && options.mythicPromotion && Math.random() <= mythicRate))
            pickedRarity = "mythic";
    }
    if (cardCounts[pickedRarity] === 0)
        pickedRarity = Object.keys(cardCounts).find(v => cardCounts[v] > 0);
    return pickedRarity;
}
function countBySlot(cardPool) {
    const counts = {};
    for (let slot in cardPool)
        counts[slot] = Object.values(cardPool[slot]).reduce((acc, c) => acc + c, 0);
    return counts;
}
function insertInBooster(card, booster) {
    let boosterByRarity = { mythic: [], rare: [], uncommon: [], common: [] };
    for (let c of booster)
        boosterByRarity[c.rarity].push(c);
    boosterByRarity[card.rarity].push(card);
    shuffleArray(boosterByRarity[card.rarity]);
    return Object.values(boosterByRarity).flat();
}
// Exactly one Planeswalker per booster
class WARBoosterFactory extends BoosterFactory {
    planeswalkers;
    constructor(cardPool, landSlot, options) {
        const [planeswalkers, filteredCardPool] = filterCardPool(cardPool, (cid) => Cards[cid].type.includes("Planeswalker"));
        super(filteredCardPool, landSlot, options);
        this.planeswalkers = planeswalkers;
    }
    // Not using the suplied cardpool here
    generateBooster(targets) {
        const plwCounts = countBySlot(this.planeswalkers);
        // Ignore the rule if suitable rarities are ignored, or there's no planeswalker left
        if (((!("uncommon" in targets) || targets["uncommon"] <= 0) &&
            (!("rare" in targets) || targets["rare"] <= 0)) ||
            Object.values(plwCounts).every(c => c === 0)) {
            return super.generateBooster(targets);
        }
        else {
            const pickedRarity = rollSpecialCardRarity(plwCounts, targets, this.options);
            const pickedPL = pickCard(this.planeswalkers[pickedRarity], []);
            const updatedTargets = Object.assign({}, targets);
            if (pickedRarity === "mythic")
                --updatedTargets["rare"];
            else
                --updatedTargets[pickedRarity];
            let booster = super.generateBooster(updatedTargets);
            if (!booster)
                return false;
            booster = insertInBooster(pickedPL, booster);
            return booster;
        }
    }
}
// At least one Legendary Creature per booster
// https://www.lethe.xyz/mtg/collation/dom.html
class DOMBoosterFactory extends BoosterFactory {
    static regex = /Legendary.*Creature/;
    legendaryCreatures;
    constructor(cardPool, landSlot, options) {
        const [legendaryCreatures, filteredCardPool] = filterCardPool(cardPool, (cid) => Cards[cid].type.match(DOMBoosterFactory.regex));
        super(filteredCardPool, landSlot, options);
        this.legendaryCreatures = legendaryCreatures;
    }
    // Not using the suplied cardpool here
    generateBooster(targets) {
        const legendaryCounts = countBySlot(this.legendaryCreatures);
        // Ignore the rule if there's no legendary creatures left
        if (Object.values(legendaryCounts).every(c => c === 0)) {
            return super.generateBooster(targets);
        }
        else {
            // Roll for legendary rarity
            const pickedRarity = rollSpecialCardRarity(legendaryCounts, targets, this.options);
            const pickedCard = pickCard(this.legendaryCreatures[pickedRarity], []);
            const updatedTargets = Object.assign({}, targets);
            if (pickedRarity === "mythic")
                --updatedTargets["rare"];
            else
                --updatedTargets[pickedRarity];
            const booster = super.generateBooster(updatedTargets);
            if (!booster)
                return false;
            // Insert the card in the appropriate slot, for Dominaria, the added Legendary is always the last card
            booster.unshift(pickedCard);
            return booster;
        }
    }
}
// Exactly one MDFC per booster
class ZNRBoosterFactory extends BoosterFactory {
    mdfcByRarity;
    constructor(cardPool, landSlot, options) {
        const [mdfcByRarity, filteredCardPool] = filterCardPool(cardPool, (cid) => Cards[cid].name.includes("//"));
        super(filteredCardPool, landSlot, options);
        this.mdfcByRarity = mdfcByRarity;
    }
    generateBooster(targets) {
        const mdfcCounts = countBySlot(this.mdfcByRarity);
        // Ignore the rule if suitable rarities are ignored, or there's no mdfc left
        if (((!("uncommon" in targets) || targets["uncommon"] <= 0) &&
            (!("rare" in targets) || targets["rare"] <= 0)) ||
            Object.values(mdfcCounts).every(c => c === 0)) {
            return super.generateBooster(targets);
        }
        else {
            // Roll for MDFC rarity
            const pickedRarity = rollSpecialCardRarity(mdfcCounts, targets, this.options);
            const pickedMDFC = pickCard(this.mdfcByRarity[pickedRarity], []);
            let updatedTargets = Object.assign({}, targets);
            if (pickedRarity === "mythic")
                --updatedTargets["rare"];
            else
                --updatedTargets[pickedRarity];
            let booster = super.generateBooster(updatedTargets);
            if (!booster)
                return false;
            booster = insertInBooster(pickedMDFC, booster);
            return booster;
        }
    }
}
// TODO Add the "Foil Etched" commanders to the foil slot.
// They shouldn't be in the card pool at all for now, Probable algorithm:
// If foilRarity === 'mythic', roll to select the card pool between "Foil Etched" (32 cards) or Regular Mythic (completeCardPool['mythic'])
// (rate unknown atm; probably the ratio between the size of both pools) then pick a card normaly in the selected pool.
// List here: https://mtg.gamepedia.com/Commander_Legends#Notable_cards
/*
    Every Commander Legends Draft Booster Pack contains two legendary cards. [...]
    Commander Legends also debuts a special kind of foil—foil-etched cards with beautiful metallic frames. In some Commander Legends Draft Boosters, you can find a foil-etched showcase legend or regular foil borderless planeswalker.
    Each Commander Legends Draft Booster contains 20 Magic cards + one ad/token, with two legends, at least one rare, and one foil.
*/
class CMRBoosterFactory extends BoosterFactory {
    static regex = /Legendary.*Creature/;
    completeCardPool;
    legendaryCreatures;
    constructor(cardPool, landSlot, options) {
        const [legendaryCreatures, filteredCardPool] = filterCardPool(cardPool, (cid) => Cards[cid].type.match(CMRBoosterFactory.regex));
        delete filteredCardPool["common"]["a69e6d8f-f742-4508-a83a-38ae84be228c"]; // Remove Prismatic Piper from the common pool (can still be found in the foil pool completeCardPool)
        super(filteredCardPool, landSlot, options);
        this.completeCardPool = cardPool;
        this.legendaryCreatures = legendaryCreatures;
    }
    // Not using the suplied cardpool here
    generateBooster(targets) {
        // 20 Cards: *13 Commons (Higher chance of a Prismatic Piper); *3 Uncommons; 2 Legendary Creatures; *1 Non-"Legendary Creature" Rare/Mythic; 1 Foil
        // * These slots are handled by the originalGenBooster function; Others are special slots with custom logic.
        if (targets === DefaultBoosterTargets)
            targets = {
                common: 13,
                uncommon: 3,
                rare: 1,
            };
        const legendaryCounts = countBySlot(this.legendaryCreatures);
        // Ignore the rule if there's no legendary creatures left
        if (Object.values(legendaryCounts).every(c => c === 0)) {
            return super.generateBooster(targets);
        }
        else {
            let updatedTargets = Object.assign({}, targets);
            let booster = [];
            // Prismatic Piper instead of a common in about 1 of every 6 packs
            if (Math.random() < 1 / 6) {
                --updatedTargets.common;
                booster = super.generateBooster(updatedTargets);
                if (!booster)
                    return false;
                booster.push(getUnique("a69e6d8f-f742-4508-a83a-38ae84be228c"));
            }
            else {
                booster = super.generateBooster(updatedTargets);
                if (!booster)
                    return false;
            }
            // 2 Legends: any combination of Uncommon/Rare/Mythic, except two Mythics
            const pickedRarities = [
                rollSpecialCardRarity(legendaryCounts, targets, this.options),
                rollSpecialCardRarity(legendaryCounts, targets, this.options),
            ];
            while (pickedRarities[0] === "mythic" &&
                pickedRarities[1] === "mythic" &&
                (legendaryCounts["uncommon"] > 0 || legendaryCounts["rare"] > 0))
                pickedRarities[1] = rollSpecialCardRarity(legendaryCounts, targets, this.options);
            for (let pickedRarity of pickedRarities) {
                const pickedCard = pickCard(this.legendaryCreatures[pickedRarity], booster);
                removeCardFromDict(pickedCard.id, this.completeCardPool[pickedCard.rarity]);
                booster.unshift(pickedCard);
            }
            // One random foil
            let foilRarity = "common";
            const rarityCheck = Math.random();
            for (let r in foilRarityRates)
                if (rarityCheck <= foilRarityRates[r] && !isEmpty(this.completeCardPool[r])) {
                    foilRarity = r;
                    break;
                }
            const pickedFoil = pickCard(this.completeCardPool[foilRarity], []);
            if (pickedFoil.id in this.cardPool[pickedFoil.rarity])
                removeCardFromDict(pickedFoil.id, this.cardPool[pickedFoil.rarity]);
            if (pickedFoil.id in this.legendaryCreatures[pickedFoil.rarity])
                removeCardFromDict(pickedFoil.id, this.legendaryCreatures[pickedFoil.rarity]);
            booster.unshift(Object.assign({ foil: true }, pickedFoil));
            return booster;
        }
    }
}
// One Timeshifted Card ("special" rarity) per booster.
// Foil rarity should be higher for this set, but we'll probably just rely on the other collation method.
class TSRBoosterFactory extends BoosterFactory {
    constructor(cardPool, landSlot, options) {
        super(cardPool, landSlot, options);
    }
    generateBooster(targets) {
        let booster = super.generateBooster(targets);
        const timeshifted = pickCard(this.cardPool["special"], []);
        if (!booster)
            return false;
        booster.push(timeshifted);
        return booster;
    }
}
// Strixhaven: One card from the Mystical Archive (sta)
class STXBoosterFactory extends BoosterFactory {
    lessonsByRarity;
    mysticalArchiveByRarity;
    constructor(cardPool, landSlot, options) {
        const [lessons, filteredCardPool] = filterCardPool(cardPool, (cid) => Cards[cid].subtypes.includes("Lesson") && Cards[cid].rarity !== "uncommon");
        super(filteredCardPool, landSlot, options);
        this.lessonsByRarity = lessons;
        // Filter STA cards according to session collections
        if (options.session && !options.session.unrestrictedCardPool()) {
            const STACards = options.session.restrictedCollection(["sta"]);
            this.mysticalArchiveByRarity = { uncommon: {}, rare: {}, mythic: {} };
            for (let cid in STACards)
                this.mysticalArchiveByRarity[Cards[cid].rarity][cid] = Math.min(options.maxDuplicates?.[Cards[cid].rarity] ?? 99, STACards[cid]);
        }
        else {
            this.mysticalArchiveByRarity = { uncommon: {}, rare: {}, mythic: {} };
            for (let cid of BoosterCardsBySet["sta"])
                this.mysticalArchiveByRarity[Cards[cid].rarity][cid] = options.maxDuplicates?.[Cards[cid].rarity] ?? 99;
        }
    }
    generateBooster(targets) {
        let booster = [];
        const mythicPromotion = this.options?.mythicPromotion ?? true;
        const allowRares = targets["rare"] > 0; // Avoid rare & mythic lessons/mystical archives
        // Lesson
        const lessonsCounts = countBySlot(this.lessonsByRarity);
        const rarityRoll = Math.random();
        const pickedRarity = allowRares
            ? mythicPromotion && rarityRoll < 0.006 && lessonsCounts["mythic"] > 0
                ? "mythic"
                : rarityRoll < 0.08 && lessonsCounts["rare"] > 0
                    ? "rare"
                    : "common"
            : "common";
        if (lessonsCounts[pickedRarity] <= 0) {
            this.onError("Error generating boosters", "Not enough Lessons available.");
            return false;
        }
        const pickedLesson = pickCard(this.lessonsByRarity[pickedRarity], []);
        let updatedTargets = Object.assign({}, targets);
        if (updatedTargets["common"] > 0)
            --updatedTargets["common"];
        booster = super.generateBooster(updatedTargets);
        if (!booster)
            return false;
        booster.push(pickedLesson);
        // Mystical Archive
        const archiveCounts = countBySlot(this.mysticalArchiveByRarity);
        const archiveRarityRoll = Math.random();
        const archiveRarity = allowRares
            ? mythicPromotion && archiveCounts["mythic"] > 0 && archiveRarityRoll < 0.066
                ? "mythic"
                : archiveCounts["rare"] > 0 && archiveRarityRoll < 0.066 + 0.264
                    ? "rare"
                    : "uncommon"
            : "uncommon";
        if (archiveCounts[archiveRarity] <= 0) {
            this.onError("Error generating boosters", "Not enough Mystical Archive cards.");
            return false;
        }
        const archive = pickCard(this.mysticalArchiveByRarity[archiveRarity], []);
        booster.push(archive);
        return booster;
    }
}
// 1 New-to-Modern reprint card (uncommon, rare, or mythic rare) [numbered #261-#303]
class MH2BoosterFactory extends BoosterFactory {
    newToModern;
    constructor(cardPool, landSlot, options) {
        const [newToModern, filteredCardPool] = filterCardPool(cardPool, (cid) => parseInt(Cards[cid].collector_number) >= 261 && parseInt(Cards[cid].collector_number) <= 303);
        if (options.foil) {
            options.foilRate = 1.0 / 3.0;
            options.foilCardPool = cardPool; // New-to-Modern can also appear in as foil
        }
        super(filteredCardPool, landSlot, options);
        this.newToModern = newToModern;
    }
    generateBooster(targets) {
        const newToModernCounts = countBySlot(this.newToModern);
        // Ignore the rule if there's no New-to-Modern reprint left
        if (Object.values(newToModernCounts).every(c => c === 0)) {
            return super.generateBooster(targets);
        }
        else {
            // Roll for New-to-Modern rarity
            const pickedRarity = rollSpecialCardRarity(newToModernCounts, targets, this.options);
            const pickedCard = pickCard(this.newToModern[pickedRarity], []);
            const booster = super.generateBooster(targets);
            if (!booster)
                return false;
            // Insert the New-to-Modern card in the appropriate slot. FIXME: Currently unknown
            booster.unshift(pickedCard);
            return booster;
        }
    }
}
// Set specific rules.
// Neither DOM, WAR or ZNR have specific rules for commons, so we don't have to worry about color balancing (colorBalancedSlot)
export const SetSpecificFactories = {
    war: (cardPool, landSlot, options) => {
        return new WARBoosterFactory(cardPool, landSlot, options);
    },
    dom: (cardPool, landSlot, options) => {
        return new DOMBoosterFactory(cardPool, landSlot, options);
    },
    znr: (cardPool, landSlot, options) => {
        return new ZNRBoosterFactory(cardPool, landSlot, options);
    },
    cmr: (cardPool, landSlot, options) => {
        return new CMRBoosterFactory(cardPool, landSlot, options);
    },
    tsr: (cardPool, landSlot, options) => {
        return new TSRBoosterFactory(cardPool, landSlot, options);
    },
    stx: (cardPool, landSlot, options) => {
        return new STXBoosterFactory(cardPool, landSlot, options);
    },
    mh2: (cardPool, landSlot, options) => {
        return new MH2BoosterFactory(cardPool, landSlot, options);
    },
};
/*
 * Another collation method using data from https://github.com/taw/magic-sealed-data
 */
import PaperBoosterData from "../data/sealed_extended_data.json";
function weightedRandomPick(arr, totalWeight, picked = [], attempt = 0) {
    let pick = randomInt(1, totalWeight);
    let idx = 0;
    let acc = arr[idx].weight;
    while (acc < pick) {
        ++idx;
        acc += arr[idx].weight;
    }
    // Duplicate protection (allows duplicates between foil and non-foil)
    // Not sure if we should checks ids or (set, number) here.
    if (attempt < 10 && picked.some((c) => c.id === arr[idx].id && c.foil === arr[idx].foil))
        return weightedRandomPick(arr, totalWeight, picked, attempt + 1);
    return arr[idx];
}
const CardsBySetAndCollectorNumber = {};
for (let cid in Cards) {
    CardsBySetAndCollectorNumber[`${Cards[cid].set}:${Cards[cid].collector_number}`] = cid;
}
export const PaperBoosterFactories = {};
for (let set of PaperBoosterData) {
    if (!constants.PrimarySets.includes(set.code) && !set.code.includes("-arena")) {
        console.log(`PaperBoosterFactories: Found '${set.code}' collation data but set is not in PrimarySets, skippink it.`);
        continue;
    }
    set.colorBalancedSheets = {};
    for (let sheetName in set.sheets) {
        for (let card of set.sheets[sheetName].cards) {
            let num = card.number;
            card.id = CardsBySetAndCollectorNumber[`${card.set}:${num}`];
            if (!card.id) {
                // Special case for double faced cards
                if (["a", "★"].includes(num[num.length - 1]))
                    num = num.substr(0, num.length - 1);
                card.id = CardsBySetAndCollectorNumber[`${card.set}:${num}`];
            }
            if (!card.id)
                console.log("Error! Could not find corresponding card:", card);
        }
        if (set.sheets[sheetName].balance_colors) {
            set.colorBalancedSheets[sheetName] = {
                W: { cards: [], total_weight: 0 },
                U: { cards: [], total_weight: 0 },
                B: { cards: [], total_weight: 0 },
                R: { cards: [], total_weight: 0 },
                G: { cards: [], total_weight: 0 },
                Mono: { cards: [], total_weight: 0 },
                Others: { cards: [], total_weight: 0 },
            };
            for (let c of set.sheets[sheetName].cards) {
                if (Cards[c.id].colors.length === 1) {
                    set.colorBalancedSheets[sheetName][Cards[c.id].colors[0]].cards.push(c);
                    set.colorBalancedSheets[sheetName][Cards[c.id].colors[0]].total_weight += c.weight;
                    set.colorBalancedSheets[sheetName]["Mono"].cards.push(c);
                    set.colorBalancedSheets[sheetName]["Mono"].total_weight += c.weight;
                }
                else {
                    set.colorBalancedSheets[sheetName]["Others"].cards.push(c);
                    set.colorBalancedSheets[sheetName]["Others"].total_weight += c.weight;
                }
            }
        }
    }
    PaperBoosterFactories[set.code] = function (options = {}) {
        let possibleContent = set.boosters;
        if (!options.foil) {
            // (Attempt to) Filter out sheets with foils if option is disabled.
            let nonFoil = set.boosters.filter((e) => !Object.keys(e.sheets).some(s => s.includes("foil")));
            if (nonFoil.length > 0)
                possibleContent = nonFoil;
        }
        return {
            set: set,
            options: options,
            possibleContent: possibleContent,
            generateBooster: function () {
                const booster = [];
                const boosterContent = weightedRandomPick(this.possibleContent, this.possibleContent.reduce((acc, val) => (acc += val.weight), 0));
                for (let sheetName in boosterContent.sheets) {
                    if (this.set.sheets[sheetName].balance_colors) {
                        const sheet = this.set.colorBalancedSheets[sheetName];
                        const pickedCards = [];
                        for (let color of "WUBRG") {
                            pickedCards.push(weightedRandomPick(sheet[color].cards, sheet[color].total_weight, pickedCards));
                        }
                        const cardsToPick = boosterContent.sheets[sheetName] - pickedCards.length;
                        // Compensate the color balancing to keep a uniform distribution of cards within the sheet.
                        const x = (sheet["Mono"].total_weight * cardsToPick -
                            sheet["Others"].total_weight * pickedCards.length) /
                            (cardsToPick * (sheet["Mono"].total_weight + sheet["Others"].total_weight));
                        for (let i = 0; i < cardsToPick; ++i) {
                            //                      For sets with only one non-mono colored card (like M14 and its unique common artifact)
                            //                      compensating for the color balance may introduce duplicates. This check makes sure it doesn't happen.
                            if (Math.random() < x ||
                                (sheet["Others"].cards.length === 1 &&
                                    pickedCards.some(c => c.id === sheet["Others"].cards[0].id)))
                                pickedCards.push(weightedRandomPick(sheet["Mono"].cards, sheet["Mono"].total_weight, pickedCards));
                            else
                                pickedCards.push(weightedRandomPick(sheet["Others"].cards, sheet["Others"].total_weight, pickedCards));
                        }
                        shuffleArray(pickedCards);
                        booster.push(...pickedCards);
                    }
                    else {
                        for (let i = 0; i < boosterContent.sheets[sheetName]; ++i) {
                            booster.push(weightedRandomPick(this.set.sheets[sheetName].cards, this.set.sheets[sheetName].total_weight, booster));
                        }
                    }
                }
                return booster
                    .map(c => (c.foil ? Object.assign({ foil: true }, getUnique(c.id)) : getUnique(c.id)))
                    .reverse();
            },
        };
    };
}