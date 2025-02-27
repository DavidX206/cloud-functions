/* eslint-disable linebreak-style */
const add = require("./add");
const canceled = require("./canceled");
const edit = require("./edit");
const paid = require("./paid");


exports.add = add.tripAddedFunction;
exports.canceled = canceled.tripCanceledFunction;
exports.edit = edit.tripEditedFunction;
exports.paid = paid.tripPaidFunction;
