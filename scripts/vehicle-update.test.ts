import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { updateVehicleApi } from "../src/modules/vehicles/vehicle-api.service.js";

describe("Vehicle Update and Persistence", () => {
  let testOrgId: string;
  let testCustomerId: string;
  let testVehicleId: string;

  before(async () => {
    // Locate or create a customer and vehicle for testing
    const customer = await prisma.customer.findFirst({
      where: { organization: { isActive: true } },
      include: { organization: true },
    });
    if (!customer) {
      throw new Error("No active customer found for test");
    }
    testOrgId = customer.organizationId;
    testCustomerId = customer.id;

    testVehicleId = `veh-test-${Date.now()}`;
    await prisma.vehicle.create({
      data: {
        id: testVehicleId,
        organizationId: testOrgId,
        customerId: testCustomerId,
        customerName: customer.name,
        registrationNumber: "KA01AB1111",
        make: "Hyundai",
        model: "i20",
        segment: "HATCHBACK",
        fuelType: "PETROL",
        color: "White",
        year: 2022,
      },
    });
  });

  after(async () => {
    if (testVehicleId) {
      await prisma.vehicle.deleteMany({
        where: { id: testVehicleId },
      });
    }
  });

  it("successfully updates vehicle registration number and persists in DB", async () => {
    const updated = await updateVehicleApi(testVehicleId, testOrgId, {
      registrationNumber: "KA01XY9999",
      color: "Black",
      year: 2023,
    });

    assert.ok(updated, "Update should return the updated vehicle");
    assert.equal(updated.registrationNumber, "KA01XY9999");
    assert.equal(updated.color, "Black");
    assert.equal(updated.year, 2023);

    // Verify persistence by querying the database directly (simulating a page refresh)
    const dbRow = await prisma.vehicle.findUnique({
      where: { id: testVehicleId },
    });
    assert.ok(dbRow, "Vehicle must exist in DB");
    assert.equal(dbRow.registrationNumber, "KA01XY9999");
    assert.equal(dbRow.color, "Black");
    assert.equal(dbRow.year, 2023);
  });

  it("returns null when updating a vehicle with non-matching organization", async () => {
    const result = await updateVehicleApi(testVehicleId, "org-non-existent", {
      registrationNumber: "KA01ZZ0000",
    });
    assert.equal(result, null);
  });
});
