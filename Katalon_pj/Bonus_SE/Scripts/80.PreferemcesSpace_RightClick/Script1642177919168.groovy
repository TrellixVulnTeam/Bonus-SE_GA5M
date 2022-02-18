import static com.kms.katalon.core.checkpoint.CheckpointFactory.findCheckpoint
import static com.kms.katalon.core.testcase.TestCaseFactory.findTestCase
import static com.kms.katalon.core.testdata.TestDataFactory.findTestData
import static com.kms.katalon.core.testobject.ObjectRepository.findTestObject
import static com.kms.katalon.core.testobject.ObjectRepository.findWindowsObject
import com.kms.katalon.core.checkpoint.Checkpoint as Checkpoint
import com.kms.katalon.core.cucumber.keyword.CucumberBuiltinKeywords as CucumberKW
import com.kms.katalon.core.mobile.keyword.MobileBuiltInKeywords as Mobile
import com.kms.katalon.core.model.FailureHandling as FailureHandling
import com.kms.katalon.core.testcase.TestCase as TestCase
import com.kms.katalon.core.testdata.TestData as TestData
import com.kms.katalon.core.testng.keyword.TestNGBuiltinKeywords as TestNGKW
import com.kms.katalon.core.testobject.TestObject as TestObject
import com.kms.katalon.core.webservice.keyword.WSBuiltInKeywords as WS
import com.kms.katalon.core.webui.keyword.WebUiBuiltInKeywords as WebUI
import com.kms.katalon.core.windows.keyword.WindowsBuiltinKeywords as Windows
import internal.GlobalVariable as GlobalVariable
import org.openqa.selenium.Keys as Keys

WebUI.openBrowser('')

WebUI.navigateToUrl('http://localhost:8080/')

WebUI.verifyElementPresent(findTestObject('Page_Element/a_Sign In'), 0)

WebUI.click(findTestObject('Object Repository/Page_Element/div_Sign In'))

WebUI.verifyElementText(findTestObject('Page_Element/a_Twitter'), 'Twitter')

WebUI.setText(findTestObject('Object Repository/Page_Element/input_Sign in with_username'), 'ptnha19')

WebUI.setEncryptedText(findTestObject('Object Repository/Page_Element/input_Username_password'), '5R3Ima4A+eOeCrCDRGMLmJpaGR3V3+YI')

WebUI.click(findTestObject('Object Repository/Page_Element/input_Forgot password_mx_Login_submit'))

WebUI.delay(10)

WebUI.click(findTestObject('Object Repository/Page_Element/div_Verify with Security Key'))

WebUI.verifyElementPresent(findTestObject('Page_Element/div_Looks good'), 0)

WebUI.setEncryptedText(findTestObject('Object Repository/Page_Element/input_Security Key_mx_Field_4'), 'T5dL0dZa3GcY/MrlN7YOn6WOTrovA4jj9xOYEG/i3Z769E9Kq/X7+gryZqF4ov+opBHLAWv3wACasluLqCMBHw==')

WebUI.click(findTestObject('Object Repository/Page_Element/button_Continue'))

WebUI.click(findTestObject('Object Repository/Page_Element/div_Done'))

WebUI.rightClick(findTestObject('Object Repository/Page_Element/span_H'))

WebUI.verifyElementClickable(findTestObject('Page_Element/span_Settings'))

WebUI.verifyElementPresent(findTestObject('Page_Element  hey ban Khoa/span_Space home'), 0)

WebUI.click(findTestObject('Object Repository/Page_Element/span_Preferences'))

WebUI.click(findTestObject('Object Repository/Page_Element/div_Sections to show_mx_Checkbox_background'))

WebUI.click(findTestObject('Object Repository/Page_Element/div_Sections to show_mx_Checkbox_checkmark'))

WebUI.click(findTestObject('Object Repository/Page_Element/div_Preferences_mx_AccessibleButton mx_Dial_364915'))

WebUI.closeBrowser()

