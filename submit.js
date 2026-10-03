async function submitWorksheet(page) {
    console.log("Submitting the worksheet...");

    try {
        // Replace with the actual selector for your submit button
        const submitButtonSelector = '.submit-button-selector';
        await page.waitForSelector(submitButtonSelector);
        await page.click(submitButtonSelector);
        console.log("Submit button clicked.");

        // Wait for any post-submission processing or navigation
        await page.waitForNavigation();

        // Wait for one minute before proceeding
        console.log("Waiting for one minute before the next task...");
        await new Promise(resolve => setTimeout(resolve, 60000));
        console.log("Wait period over.");

    } catch (error) {
        console.error("Error during submission or waiting:", error);
    }
}

module.exports = submitWorksheet;
